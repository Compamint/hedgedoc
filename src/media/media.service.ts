/*
 * SPDX-FileCopyrightText: 2021 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import * as FileType from 'file-type';
import { Repository } from 'typeorm';
import mediaConfiguration, { MediaConfig } from '../config/media.config';
import { ClientError, NotInDBError, PermissionError } from '../errors/errors';
import { ConsoleLoggerService } from '../logger/console-logger.service';
import { NotesService } from '../notes/notes.service';
import { UsersService } from '../users/users.service';
import { BackendType } from './backends/backend-type.enum';
import { FilesystemBackend } from './backends/filesystem-backend';
import { MediaBackend } from './media-backend.interface';
import { MediaUpload } from './media-upload.entity';
import { MediaUploadUrlDto } from './media-upload-url.dto';
import { S3Backend } from './backends/s3-backend';
import { AzureBackend } from './backends/azure-backend';
import { ImgurBackend } from './backends/imgur-backend';
import { User } from '../users/user.entity';
import { MediaUploadDto } from './media-upload.dto';
import { Note } from '../notes/note.entity';

@Injectable()
export class MediaService {
  mediaBackend: MediaBackend;
  mediaBackendType: BackendType;

  constructor(
    private readonly logger: ConsoleLoggerService,
    @InjectRepository(MediaUpload)
    private mediaUploadRepository: Repository<MediaUpload>,
    private notesService: NotesService,
    private usersService: UsersService,
    private moduleRef: ModuleRef,
    @Inject(mediaConfiguration.KEY)
    private mediaConfig: MediaConfig,
  ) {
    this.logger.setContext(MediaService.name);
    this.mediaBackendType = this.chooseBackendType();
    this.mediaBackend = this.getBackendFromType(this.mediaBackendType);
  }

  private static isAllowedMimeType(mimeType: string): boolean {
    const allowedTypes = [
      'image/apng',
      'image/bmp',
      'image/gif',
      'image/heif',
      'image/heic',
      'image/heif-sequence',
      'image/heic-sequence',
      'image/jpeg',
      'image/png',
      'image/svg+xml',
      'image/tiff',
      'image/webp',
    ];
    return allowedTypes.includes(mimeType);
  }

  /**
   * @async
   * Save the given buffer to the configured MediaBackend and create a MediaUploadEntity to track where the file is, who uploaded it and to which note.
   * @param {Buffer} fileBuffer - the buffer of the file to save.
   * @param {string} username - the username of the user who uploaded this file
   * @param {string} noteId - the id or alias of the note which will be associated with the new file.
   * @return {string} the url of the saved file
   * @throws {ClientError} the MIME type of the file is not supported.
   * @throws {NotInDBError} - the note or user is not in the database
   * @throws {MediaBackendError} - there was an error saving the file
   */
  async saveFile(
    fileBuffer: Buffer,
    username: string,
    noteId: string,
  ): Promise<string> {
    this.logger.debug(
      `Saving file for note '${noteId}' and user '${username}'`,
      'saveFile',
    );
    const note = await this.notesService.getNoteByIdOrAlias(noteId);
    const user = await this.usersService.getUserByUsername(username);
    const fileTypeResult = await FileType.fromBuffer(fileBuffer);
    if (!fileTypeResult) {
      throw new ClientError('Could not detect file type.');
    }
    if (!MediaService.isAllowedMimeType(fileTypeResult.mime)) {
      throw new ClientError('MIME type not allowed.');
    }
    const mediaUpload = MediaUpload.create(
      note,
      user,
      fileTypeResult.ext,
      this.mediaBackendType,
    );
    this.logger.debug(`Generated filename: '${mediaUpload.id}'`, 'saveFile');
    const [url, backendData] = await this.mediaBackend.saveFile(
      fileBuffer,
      mediaUpload.id,
    );
    mediaUpload.backendData = backendData;
    mediaUpload.fileUrl = url;
    await this.mediaUploadRepository.save(mediaUpload);
    return url;
  }

  /**
   * @async
   * Try to delete the file specified by the filename with the user specified by the username.
   * @param {string} filename - the name of the file to delete.
   * @param {string} username - the username of the user who uploaded this file
   * @return {string} the url of the saved file
   * @throws {PermissionError} the user is not permitted to delete this file.
   * @throws {NotInDBError} - the file entry specified is not in the database
   * @throws {MediaBackendError} - there was an error deleting the file
   */
  async deleteFile(filename: string, username: string): Promise<void> {
    this.logger.debug(
      `Deleting '${filename}' for user '${username}'`,
      'deleteFile',
    );
    const mediaUpload = await this.findUploadByFilename(filename);
    if (mediaUpload.user.userName !== username) {
      this.logger.warn(
        `${username} tried to delete '${filename}', but is not the owner`,
        'deleteFile',
      );
      throw new PermissionError(
        `File '${filename}' is not owned by '${username}'`,
      );
    }
    await this.mediaBackend.deleteFile(filename, mediaUpload.backendData);
    await this.mediaUploadRepository.remove(mediaUpload);
  }

  /**
   * @async
   * Find a file entry by its filename.
   * @param {string} filename - the name of the file entry to find
   * @return {MediaUpload} the file entry, that was searched for
   * @throws {NotInDBError} - the file entry specified is not in the database
   * @throws {MediaBackendError} - there was an error retrieving the url
   */
  async findUploadByFilename(filename: string): Promise<MediaUpload> {
    const mediaUpload = await this.mediaUploadRepository.findOne(filename, {
      relations: ['user'],
    });
    if (mediaUpload === undefined) {
      throw new NotInDBError(
        `MediaUpload with filename '${filename}' not found`,
      );
    }
    return mediaUpload;
  }

  /**
   * @async
   * List all uploads by a specific user
   * @param {User} user - the specific user
   * @return {MediaUpload[]} arary of media uploads owned by the user
   */
  async listUploadsByUser(user: User): Promise<MediaUpload[]> {
    const mediaUploads = await this.mediaUploadRepository.find({
      where: { user: user },
      relations: ['user', 'note'],
    });
    if (mediaUploads === undefined) {
      return [];
    }
    return mediaUploads;
  }

  /**
   * @async
   * List all uploads by a specific note
   * @param {Note} note - the specific user
   * @return {MediaUpload[]} arary of media uploads owned by the user
   */
  async listUploadsByNote(note: Note): Promise<MediaUpload[]> {
    const mediaUploads = await this.mediaUploadRepository.find({
      where: { note: note },
      relations: ['user', 'note'],
    });
    if (mediaUploads === undefined) {
      return [];
    }
    return mediaUploads;
  }

  private chooseBackendType(): BackendType {
    switch (this.mediaConfig.backend.use) {
      case 'filesystem':
        return BackendType.FILESYSTEM;
      case 'azure':
        return BackendType.AZURE;
      case 'imgur':
        return BackendType.IMGUR;
      case 's3':
        return BackendType.S3;
    }
  }

  private getBackendFromType(type: BackendType): MediaBackend {
    switch (type) {
      case BackendType.FILESYSTEM:
        return this.moduleRef.get(FilesystemBackend);
      case BackendType.S3:
        return this.moduleRef.get(S3Backend);
      case BackendType.AZURE:
        return this.moduleRef.get(AzureBackend);
      case BackendType.IMGUR:
        return this.moduleRef.get(ImgurBackend);
    }
  }

  toMediaUploadDto(mediaUpload: MediaUpload): MediaUploadDto {
    return {
      url: mediaUpload.fileUrl,
      noteId: mediaUpload.note.id,
      createdAt: mediaUpload.createdAt,
      userName: mediaUpload.user.userName,
    };
  }

  toMediaUploadUrlDto(url: string): MediaUploadUrlDto {
    return {
      link: url,
    };
  }
}

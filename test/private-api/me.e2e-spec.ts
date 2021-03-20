/*
 * SPDX-FileCopyrightText: 2021 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable
@typescript-eslint/no-unsafe-assignment,
@typescript-eslint/no-unsafe-member-access
*/

import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as request from 'supertest';
import mediaConfigMock from '../../src/config/media.config.mock';
import { GroupsModule } from '../../src/groups/groups.module';
import { LoggerModule } from '../../src/logger/logger.module';
import { NotesModule } from '../../src/notes/notes.module';
import { PermissionsModule } from '../../src/permissions/permissions.module';
import { AuthModule } from '../../src/auth/auth.module';
import { UsersService } from '../../src/users/users.service';
import { User } from '../../src/users/user.entity';
import { UsersModule } from '../../src/users/users.module';
import { PrivateApiModule } from '../../src/api/private/private-api.module';
import { UserInfoDto } from '../../src/users/user-info.dto';
import { MediaModule } from '../../src/media/media.module';
import { HistoryModule } from '../../src/history/history.module';
import { NotInDBError } from '../../src/errors/errors';

describe('Me', () => {
  let app: INestApplication;
  let userService: UsersService;
  let user: User;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [mediaConfigMock],
        }),
        PrivateApiModule,
        NotesModule,
        PermissionsModule,
        GroupsModule,
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: './hedgedoc-e2e-private-me.sqlite',
          autoLoadEntities: true,
          synchronize: true,
          dropSchema: true,
        }),
        LoggerModule,
        AuthModule,
        UsersModule,
        MediaModule,
        HistoryModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    //historyService = moduleRef.get();
    userService = moduleRef.get(UsersService);
    user = await userService.createUser('hardcoded', 'Testy');
    /*const notesService = moduleRef.get(NotesService);
    note = await notesService.createNote(content, null, user);
    note2 = await notesService.createNote(content, 'note2', user);*/
  });

  it('GET /me', async () => {
    const userInfo = userService.toUserDto(user);
    const response = await request(app.getHttpServer())
      .get('/me')
      .expect('Content-Type', /json/)
      .expect(200);
    const gotUser = response.body as UserInfoDto;
    expect(gotUser).toEqual(userInfo);
  });

  it('DELETE /me', async () => {
    const dbUser = await userService.getUserByUsername('hardcoded');
    expect(dbUser).toBeInstanceOf(User);
    await request(app.getHttpServer())
      .delete('/me')
      .expect('Content-Type', /json/)
      .expect(200);
    try {
      await userService.getUserByUsername('hardcoded');
    } catch (e) {
      expect(e).toBeInstanceOf(NotInDBError);
    }
  });

  it('POST /me', async () => {
    const newDisplayName = 'Another name';
    expect(user.displayName).not.toEqual(newDisplayName);
    await request(app.getHttpServer())
      .post('/me')
      .send({
        name: newDisplayName,
      })
      .expect(200);
    const dbUser = await userService.getUserByUsername('hardcoded');
    expect(dbUser.displayName).toEqual(newDisplayName);
  });
});

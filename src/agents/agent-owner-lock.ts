import { NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { activeUserSql } from '../users/active-user';

/** Owner before agent, including the implicit owner FK lock acquired by audit INSERT. */
export async function lockActiveAgentOwner(tx: Pick<DatabaseService, 'query'>, userId: string): Promise<void> {
  const owner = await tx.query(`SELECT id FROM "user" WHERE id = $1 AND ${activeUserSql('')} FOR SHARE`, [userId]);
  if (!owner.rowCount) throw new NotFoundException('USER_NOT_FOUND');
}

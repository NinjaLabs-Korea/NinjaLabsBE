import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * 전역 DB 모듈 — Supabase PostgreSQL에 pg Pool로 접속한다.
 * 스키마의 소스 오브 트루스는 supabase/migrations/*.sql 이며,
 * ORM 대신 raw SQL을 사용한다 (ERD 문서와 1:1 대응 유지 목적).
 * 팀 합의에 따라 추후 Kysely/Prisma 도입 가능.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}

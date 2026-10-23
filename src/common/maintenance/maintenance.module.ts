import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

/** 만료 challenge/세션/로그인 코드 정리 크론 — DatabaseModule은 전역 */
@Module({ providers: [MaintenanceService] })
export class MaintenanceModule {}

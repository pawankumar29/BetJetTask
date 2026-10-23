import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { WalletController } from './wallet/wallet.controller';
import { WalletService } from './wallet/wallet.service';

@Module({
  controllers: [WalletController],
  providers: [DbService, WalletService],
})
export class AppModule {}

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreditRequest, DebitRequest, RollbackRequest } from './wallet.dto';

@Controller('wallet')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  @Get(':userId')
  balance(@Param('userId') userId: string) {
    return this.wallet.getBalance(Number(userId));
  }

  @Post('debit')
  @HttpCode(200)
  debit(@Body() body: DebitRequest) {
    return this.wallet.debit(body);
  }

  @Post('credit')
  @HttpCode(200)
  credit(@Body() body: CreditRequest) {
    return this.wallet.credit(body);
  }

  @Post('rollback')
  @HttpCode(200)
  rollback(@Body() body: RollbackRequest) {
    return this.wallet.rollback(body);
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreditRequest, DebitRequest, RollbackRequest, WalletResponse } from './wallet.dto';

@Controller('wallet')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  @Get(':userId')
  @HttpCode(200)
  async balance(@Param('userId') userId: string): Promise<WalletResponse> {
    try {
      const id = Number(userId);
      return await this.wallet.getBalance(id);
    } catch {
      return { status: 'UNKNOWN_USER' };
    }
  }

  @Post('debit')
  @HttpCode(200)
  async debit(@Body() body: DebitRequest): Promise<WalletResponse> {
    try {
      return await this.wallet.debit(body);
    } catch {
      return { status: 'INVALID_REQUEST', txId: body?.txId };
    }
  }

  @Post('credit')
  @HttpCode(200)
  async credit(@Body() body: CreditRequest): Promise<WalletResponse> {
    try {
      return await this.wallet.credit(body);
    } catch {
      return { status: 'INVALID_REQUEST', txId: body?.txId };
    }
  }

  @Post('rollback')
  @HttpCode(200)
  async rollback(@Body() body: RollbackRequest): Promise<WalletResponse> {
    try {
      return await this.wallet.rollback(body);
    } catch {
      return { status: 'INVALID_REQUEST', txId: body?.txId };
    }
  }
}

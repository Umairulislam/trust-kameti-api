import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  StreamableFile,
  Res,
  HttpCode,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_RECEIPT_SIZE,
  ReceiptFile,
  ReceiptFilePipe,
} from './receipt-file.pipe';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { QueryPaymentDto } from './dto/query-payment.dto';
import { AdminGuard } from '../auth/guards/admin.guard';

@Controller('committees/:committeeId/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  record(
    @Param('committeeId') committeeId: string,
    @Body() dto: CreatePaymentDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: string };
    return this.paymentsService.create(committeeId, dto, user.id);
  }

  @Get()
  findAll(
    @Param('committeeId') committeeId: string,
    @Query() query: QueryPaymentDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: string };
    return this.paymentsService.findAll(committeeId, query, user.id);
  }

  @Get(':id')
  findOne(
    @Param('committeeId') committeeId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { id: string };
    return this.paymentsService.findOne(committeeId, id, user.id);
  }

  @Post(':id/receipt')
  @UseInterceptors(
    FileInterceptor('receipt', {
      limits: { fileSize: MAX_RECEIPT_SIZE, files: 1, fields: 0 },
    }),
  )
  uploadReceipt(
    @Param('committeeId') committeeId: string,
    @Param('id') id: string,
    @Req() req: Request,
    @UploadedFile(new ReceiptFilePipe()) file: ReceiptFile,
  ) {
    const user = req.user as { id: string };
    return this.paymentsService.uploadReceipt(committeeId, id, user.id, file);
  }

  @Get(':id/receipt')
  async getReceipt(
    @Param('committeeId') committeeId: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as { id: string };
    const receipt = await this.paymentsService.getReceipt(
      committeeId,
      id,
      user.id,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const extension = receipt.mimeType === 'image/png' ? 'png' : 'jpg';
    return new StreamableFile(receipt.buffer, {
      type: receipt.mimeType,
      disposition: `inline; filename="receipt.${extension}"`,
      length: receipt.buffer.length,
    });
  }

  @Post(':id/verify')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  verify(
    @Param('committeeId') committeeId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { id: string };
    return this.paymentsService.verify(committeeId, id, user.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  reject(
    @Param('committeeId') committeeId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = req.user as { id: string };
    return this.paymentsService.reject(committeeId, id, user.id);
  }
}

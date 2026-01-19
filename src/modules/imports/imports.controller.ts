import {
  Controller,
  Post,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ImportsService } from './imports.service';
import { ImportResultDto } from './dto/import-result.dto';

@ApiTags('Imports')
@Controller('imports')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('nexo-csv/:credentialId')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import Nexo transactions from CSV file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Nexo CSV export file',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import results',
    type: ImportResultDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid file or credential' })
  async importNexoCsv(
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Param('credentialId') credentialId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<ImportResultDto> {
    if (!file) {
      throw new BadRequestException('CSV file is required');
    }

    if (!file.originalname.endsWith('.csv')) {
      throw new BadRequestException('File must be a CSV file');
    }

    return this.importsService.importNexoCsv(file.buffer, credentialId, userId);
  }

  // ==================== BINANCE EXCEL IMPORTS ====================

  @Post('binance-deposits/:credentialId')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import Binance deposits from Excel file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Binance Deposit History Excel file',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import results',
    type: ImportResultDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid file or credential' })
  async importBinanceDeposits(
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Param('credentialId') credentialId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<ImportResultDto> {
    if (!file) {
      throw new BadRequestException('Excel file is required');
    }

    if (!file.originalname.endsWith('.xlsx')) {
      throw new BadRequestException('File must be an Excel file (.xlsx)');
    }

    return this.importsService.importBinanceDeposits(file.buffer, credentialId, userId);
  }

  @Post('binance-withdrawals/:credentialId')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import Binance withdrawals from Excel file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Binance Withdraw History Excel file',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import results',
    type: ImportResultDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid file or credential' })
  async importBinanceWithdrawals(
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Param('credentialId') credentialId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<ImportResultDto> {
    if (!file) {
      throw new BadRequestException('Excel file is required');
    }

    if (!file.originalname.endsWith('.xlsx')) {
      throw new BadRequestException('File must be an Excel file (.xlsx)');
    }

    return this.importsService.importBinanceWithdrawals(file.buffer, credentialId, userId);
  }

  @Post('binance-transactions/:credentialId')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Import Binance transaction history from Excel file',
    description: 'Imports interest, cashback, trades, card spending, and other transactions',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Binance Transaction History Excel file',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import results',
    type: ImportResultDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid file or credential' })
  async importBinanceTransactions(
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Param('credentialId') credentialId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<ImportResultDto> {
    if (!file) {
      throw new BadRequestException('Excel file is required');
    }

    if (!file.originalname.endsWith('.xlsx')) {
      throw new BadRequestException('File must be an Excel file (.xlsx)');
    }

    return this.importsService.importBinanceTransactions(file.buffer, credentialId, userId);
  }
}

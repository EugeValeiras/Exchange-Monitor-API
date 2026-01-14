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
@Controller('api/imports')
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
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ExchangeCredentialsService } from './exchange-credentials.service';
import { MarketsCacheService } from './markets-cache.service';
import { CreateCredentialDto } from './dto/create-credential.dto';
import { UpdateCredentialDto } from './dto/update-credential.dto';
import { UpdateSymbolsDto } from './dto/update-symbols.dto';
import { CredentialResponseDto } from './dto/credential-response.dto';
import { AvailableSymbolsResponseDto } from './dto/available-symbols.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ExchangeType } from '../../common/constants/exchanges.constant';

@ApiTags('credentials')
@Controller('credentials')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ExchangeCredentialsController {
  constructor(
    private readonly credentialsService: ExchangeCredentialsService,
    private readonly marketsCacheService: MarketsCacheService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Add new exchange credentials' })
  @ApiResponse({ status: 201, type: CredentialResponseDto })
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateCredentialDto,
  ): Promise<CredentialResponseDto> {
    const credential = await this.credentialsService.create(userId, dto);
    return this.toResponse(credential);
  }

  @Get()
  @ApiOperation({ summary: 'List all credentials for current user' })
  @ApiResponse({ status: 200, type: [CredentialResponseDto] })
  async findAll(
    @CurrentUser('userId') userId: string,
  ): Promise<CredentialResponseDto[]> {
    const credentials = await this.credentialsService.findAllByUser(userId);
    return credentials.map((c) => this.toResponse(c));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get credential by ID' })
  @ApiResponse({ status: 200, type: CredentialResponseDto })
  @ApiResponse({ status: 404, description: 'Credential not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<CredentialResponseDto> {
    const credential = await this.credentialsService.findById(id, userId);
    return this.toResponse(credential);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update credential' })
  @ApiResponse({ status: 200, type: CredentialResponseDto })
  async update(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateCredentialDto,
  ): Promise<CredentialResponseDto> {
    const credential = await this.credentialsService.update(id, userId, dto);
    return this.toResponse(credential);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete credential' })
  @ApiResponse({ status: 200, description: 'Credential deleted' })
  async remove(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<{ message: string }> {
    await this.credentialsService.delete(id, userId);
    return { message: 'Credential deleted successfully' };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test exchange connection' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  async testConnection(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<{ success: boolean; message: string }> {
    // This will be implemented when we add the exchange adapters
    const credential = await this.credentialsService.findById(id, userId);
    return {
      success: true,
      message: `Connection test for ${credential.exchange} pending implementation`,
    };
  }

  @Get('symbols/:exchange')
  @ApiOperation({ summary: 'Get available symbols for an exchange' })
  @ApiResponse({ status: 200, type: AvailableSymbolsResponseDto })
  @ApiQuery({ name: 'search', required: false, example: 'BTC' })
  async getAvailableSymbols(
    @Param('exchange') exchange: ExchangeType,
    @Query('search') search?: string,
  ): Promise<AvailableSymbolsResponseDto> {
    const result = await this.marketsCacheService.getAvailableSymbols(
      exchange,
      search,
    );
    return {
      exchange,
      symbols: result.symbols,
      total: result.symbols.length,
      cachedAt: result.cachedAt,
    };
  }

  @Patch(':id/symbols')
  @ApiOperation({ summary: 'Update symbols for a credential' })
  @ApiResponse({ status: 200, type: CredentialResponseDto })
  async updateSymbols(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateSymbolsDto,
  ): Promise<CredentialResponseDto> {
    const credential = await this.credentialsService.updateSymbols(
      id,
      userId,
      dto.symbols,
    );
    return this.toResponse(credential);
  }

  private toResponse(credential: any): CredentialResponseDto {
    return {
      id: credential._id.toString(),
      exchange: credential.exchange,
      label: credential.label,
      isActive: credential.isActive,
      lastSyncAt: credential.lastSyncAt,
      lastError: credential.lastError,
      symbols: credential.symbols || [],
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    };
  }
}

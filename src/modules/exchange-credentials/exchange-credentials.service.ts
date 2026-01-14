import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import {
  ExchangeCredential,
  ExchangeCredentialDocument,
} from './schemas/exchange-credential.schema';
import { CreateCredentialDto } from './dto/create-credential.dto';
import { UpdateCredentialDto } from './dto/update-credential.dto';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { ExchangeType } from '../../common/constants/exchanges.constant';

@Injectable()
export class ExchangeCredentialsService {
  constructor(
    @InjectModel(ExchangeCredential.name)
    private credentialModel: Model<ExchangeCredentialDocument>,
    private readonly encryptionService: EncryptionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(
    userId: string,
    dto: CreateCredentialDto,
  ): Promise<ExchangeCredentialDocument> {
    // For NEXO_MANUAL, API keys are not required
    const isNexoManual = dto.exchange === ExchangeType.NEXO_MANUAL;

    const credential = new this.credentialModel({
      userId: new Types.ObjectId(userId),
      exchange: dto.exchange,
      label: dto.label,
      apiKeyEncrypted: dto.apiKey
        ? this.encryptionService.encrypt(dto.apiKey)
        : isNexoManual
          ? this.encryptionService.encrypt('nexo-manual-no-key')
          : undefined,
      apiSecretEncrypted: dto.apiSecret
        ? this.encryptionService.encrypt(dto.apiSecret)
        : isNexoManual
          ? this.encryptionService.encrypt('nexo-manual-no-secret')
          : undefined,
      passphraseEncrypted: dto.passphrase
        ? this.encryptionService.encrypt(dto.passphrase)
        : undefined,
    });

    return credential.save();
  }

  async findAllByUser(userId: string): Promise<ExchangeCredentialDocument[]> {
    return this.credentialModel.find({ userId: new Types.ObjectId(userId) });
  }

  async findById(
    id: string,
    userId: string | null,
  ): Promise<ExchangeCredentialDocument> {
    const credential = await this.credentialModel.findById(id);
    if (!credential) {
      throw new NotFoundException('Credential not found');
    }
    // Skip user validation for internal use (when userId is null)
    if (userId !== null && credential.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return credential;
  }

  async findAllActive(): Promise<ExchangeCredentialDocument[]> {
    return this.credentialModel.find({ isActive: true });
  }

  async findActiveByUser(userId: string): Promise<ExchangeCredentialDocument[]> {
    return this.credentialModel.find({
      userId: new Types.ObjectId(userId),
      isActive: true,
    });
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateCredentialDto,
  ): Promise<ExchangeCredentialDocument> {
    const credential = await this.findById(id, userId);

    if (dto.label !== undefined) {
      credential.label = dto.label;
    }
    if (dto.apiKey !== undefined) {
      credential.apiKeyEncrypted = this.encryptionService.encrypt(dto.apiKey);
    }
    if (dto.apiSecret !== undefined) {
      credential.apiSecretEncrypted = this.encryptionService.encrypt(
        dto.apiSecret,
      );
    }
    if (dto.passphrase !== undefined) {
      credential.passphraseEncrypted = this.encryptionService.encrypt(
        dto.passphrase,
      );
    }
    if (dto.isActive !== undefined) {
      credential.isActive = dto.isActive;
    }
    if (dto.symbols !== undefined) {
      credential.symbols = dto.symbols;
    }

    return credential.save();
  }

  async updateSymbols(
    id: string,
    userId: string,
    symbols: string[],
  ): Promise<ExchangeCredentialDocument> {
    const credential = await this.findById(id, userId);
    credential.symbols = symbols;
    await credential.save();

    // Emit event to notify WebSocket services to refresh subscriptions
    this.eventEmitter.emit('credential.symbols.updated', {
      credentialId: id,
      symbols,
    });

    return credential;
  }

  async delete(id: string, userId: string): Promise<void> {
    const credential = await this.findById(id, userId);
    await credential.deleteOne();
  }

  async updateLastSync(id: string | Types.ObjectId): Promise<void> {
    await this.credentialModel.findByIdAndUpdate(id, {
      lastSyncAt: new Date(),
      lastError: null,
    });
  }

  async updateLastError(id: string | Types.ObjectId, error: string): Promise<void> {
    await this.credentialModel.findByIdAndUpdate(id, {
      lastError: error,
    });
  }

  getDecryptedCredentials(credential: ExchangeCredentialDocument): {
    apiKey: string;
    apiSecret: string;
    passphrase?: string;
  } {
    return {
      apiKey: this.encryptionService.decrypt(credential.apiKeyEncrypted),
      apiSecret: this.encryptionService.decrypt(credential.apiSecretEncrypted),
      passphrase: credential.passphraseEncrypted
        ? this.encryptionService.decrypt(credential.passphraseEncrypted)
        : undefined,
    };
  }
}

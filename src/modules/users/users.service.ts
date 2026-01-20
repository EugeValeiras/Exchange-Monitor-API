import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument, PasskeyCredential } from './schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  // In-memory store for global challenges (for discoverable credentials)
  // In production, use Redis for multi-instance deployments
  private globalChallenges = new Map<string, { challenge: string; expiresAt: Date }>();

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<UserDocument> {
    const existingUser = await this.userModel.findOne({ email: createUserDto.email });
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(createUserDto.password, 10);

    const user = new this.userModel({
      email: createUserDto.email,
      passwordHash,
      firstName: createUserDto.firstName,
      lastName: createUserDto.lastName,
      role: createUserDto.role || 'user',
    });

    return user.save();
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() });
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findAllActive(): Promise<UserDocument[]> {
    return this.userModel.find({ isActive: true });
  }

  async updateLastLogin(userId: string | Types.ObjectId): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, { lastLoginAt: new Date() });
  }

  async validatePassword(user: UserDocument, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  // Favorites methods
  async getFavorites(userId: string | Types.ObjectId): Promise<string[]> {
    const user = await this.userModel.findById(userId);
    return user?.favoriteAssets || [];
  }

  async updateFavorites(userId: string | Types.ObjectId, assets: string[]): Promise<string[]> {
    const normalizedAssets = assets.map(a => a.toUpperCase());
    const result = await this.userModel.findByIdAndUpdate(
      userId,
      { $set: { favoriteAssets: normalizedAssets } },
      { new: true },
    );
    return result?.favoriteAssets || [];
  }

  async addFavorite(userId: string | Types.ObjectId, asset: string): Promise<string[]> {
    const result = await this.userModel.findByIdAndUpdate(
      userId,
      { $addToSet: { favoriteAssets: asset.toUpperCase() } },
      { new: true },
    );
    return result?.favoriteAssets || [];
  }

  async removeFavorite(userId: string | Types.ObjectId, asset: string): Promise<string[]> {
    const result = await this.userModel.findByIdAndUpdate(
      userId,
      { $pull: { favoriteAssets: asset.toUpperCase() } },
      { new: true },
    );
    return result?.favoriteAssets || [];
  }

  async toggleFavorite(
    userId: string | Types.ObjectId,
    asset: string,
  ): Promise<{ favorites: string[]; isFavorite: boolean }> {
    const user = await this.userModel.findById(userId);
    const normalizedAsset = asset.toUpperCase();
    const isFavorite = user?.favoriteAssets?.includes(normalizedAsset) || false;

    let result: UserDocument | null;
    if (isFavorite) {
      result = await this.userModel.findByIdAndUpdate(
        userId,
        { $pull: { favoriteAssets: normalizedAsset } },
        { new: true },
      );
    } else {
      result = await this.userModel.findByIdAndUpdate(
        userId,
        { $addToSet: { favoriteAssets: normalizedAsset } },
        { new: true },
      );
    }

    return {
      favorites: result?.favoriteAssets || [],
      isFavorite: !isFavorite,
    };
  }

  // Push token methods
  async addPushToken(userId: string | Types.ObjectId, token: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $addToSet: { pushTokens: token },
    });
  }

  async removePushToken(userId: string | Types.ObjectId, token: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $pull: { pushTokens: token },
    });
  }

  async findUsersWithFavoriteAsset(asset: string): Promise<UserDocument[]> {
    const normalizedAsset = asset.toUpperCase();
    return this.userModel.find({
      isActive: true,
      favoriteAssets: normalizedAsset,
      'notificationSettings.enabled': true,
      pushTokens: { $exists: true, $ne: [] },
    });
  }

  async updateNotificationSettings(
    userId: string | Types.ObjectId,
    settings: {
      enabled: boolean;
      priceChangeThreshold: number;
      quietHoursStart?: string;
      quietHoursEnd?: string;
    },
  ): Promise<UserDocument> {
    const user = await this.userModel.findByIdAndUpdate(
      userId,
      { $set: { notificationSettings: settings } },
      { new: true },
    );
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findUsersWithPushTokens(): Promise<UserDocument[]> {
    return this.userModel.find({
      isActive: true,
      pushTokens: { $exists: true, $ne: [] },
    });
  }

  // Passkey challenge methods
  async setPasskeyChallenge(
    userId: string | Types.ObjectId,
    challenge: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $set: { currentChallenge: challenge, challengeExpiresAt: expiresAt },
    });
  }

  async clearPasskeyChallenge(userId: string | Types.ObjectId): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $unset: { currentChallenge: 1, challengeExpiresAt: 1 },
    });
  }

  // Passkey credential methods
  async addPasskeyCredential(
    userId: string | Types.ObjectId,
    credential: PasskeyCredential,
  ): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $push: { passkeys: credential },
    });
  }

  async updatePasskeyCredential(
    userId: string | Types.ObjectId,
    credentialId: string,
    updates: Partial<Pick<PasskeyCredential, 'counter' | 'lastUsedAt'>>,
  ): Promise<void> {
    const updateFields: Record<string, any> = {};
    if (updates.counter !== undefined) {
      updateFields['passkeys.$.counter'] = updates.counter;
    }
    if (updates.lastUsedAt !== undefined) {
      updateFields['passkeys.$.lastUsedAt'] = updates.lastUsedAt;
    }

    await this.userModel.findOneAndUpdate(
      { _id: userId, 'passkeys.credentialId': credentialId },
      { $set: updateFields },
    );
  }

  async removePasskeyCredential(
    userId: string | Types.ObjectId,
    credentialId: string,
  ): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $pull: { passkeys: { credentialId } },
    });
  }

  // Find user by passkey credential ID (for discoverable credentials)
  async findByPasskeyCredentialId(credentialId: string): Promise<UserDocument | null> {
    return this.userModel.findOne({
      'passkeys.credentialId': credentialId,
    });
  }

  // Global challenge methods (for discoverable credentials without email)
  async storeGlobalChallenge(challenge: string, expiresAt: Date): Promise<void> {
    // Clean up expired challenges
    const now = new Date();
    for (const [key, value] of this.globalChallenges.entries()) {
      if (value.expiresAt < now) {
        this.globalChallenges.delete(key);
      }
    }
    // Store new challenge
    this.globalChallenges.set(challenge, { challenge, expiresAt });
  }

  async getGlobalChallenge(): Promise<{ challenge: string; expiresAt: Date } | null> {
    // Return the most recent valid challenge
    const now = new Date();
    for (const [, value] of this.globalChallenges.entries()) {
      if (value.expiresAt > now) {
        return value;
      }
    }
    return null;
  }

  async clearGlobalChallenge(): Promise<void> {
    this.globalChallenges.clear();
  }
}

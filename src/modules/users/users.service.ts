import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
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
}

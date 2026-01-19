import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  UpdateFavoritesDto,
  FavoritesResponseDto,
  ToggleFavoriteResponseDto,
} from './dto/favorites.dto';

@ApiTags('favorites')
@Controller('favorites')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FavoritesController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Get user favorite assets' })
  @ApiResponse({ status: 200, type: FavoritesResponseDto })
  async getFavorites(
    @CurrentUser('userId') userId: string,
  ): Promise<FavoritesResponseDto> {
    const favorites = await this.usersService.getFavorites(userId);
    return { favorites };
  }

  @Put()
  @ApiOperation({ summary: 'Replace all favorites' })
  @ApiResponse({ status: 200, type: FavoritesResponseDto })
  async updateFavorites(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateFavoritesDto,
  ): Promise<FavoritesResponseDto> {
    const favorites = await this.usersService.updateFavorites(userId, dto.assets);
    return { favorites };
  }

  @Post(':asset')
  @ApiOperation({ summary: 'Add asset to favorites' })
  @ApiResponse({ status: 200, type: FavoritesResponseDto })
  @ApiParam({ name: 'asset', example: 'BTC' })
  async addFavorite(
    @CurrentUser('userId') userId: string,
    @Param('asset') asset: string,
  ): Promise<FavoritesResponseDto> {
    const favorites = await this.usersService.addFavorite(userId, asset);
    return { favorites };
  }

  @Delete(':asset')
  @ApiOperation({ summary: 'Remove asset from favorites' })
  @ApiResponse({ status: 200, type: FavoritesResponseDto })
  @ApiParam({ name: 'asset', example: 'BTC' })
  async removeFavorite(
    @CurrentUser('userId') userId: string,
    @Param('asset') asset: string,
  ): Promise<FavoritesResponseDto> {
    const favorites = await this.usersService.removeFavorite(userId, asset);
    return { favorites };
  }

  @Post(':asset/toggle')
  @ApiOperation({ summary: 'Toggle favorite status for an asset' })
  @ApiResponse({ status: 200, type: ToggleFavoriteResponseDto })
  @ApiParam({ name: 'asset', example: 'BTC' })
  async toggleFavorite(
    @CurrentUser('userId') userId: string,
    @Param('asset') asset: string,
  ): Promise<ToggleFavoriteResponseDto> {
    return this.usersService.toggleFavorite(userId, asset);
  }
}

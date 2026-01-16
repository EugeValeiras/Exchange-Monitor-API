import { IsArray, IsString, ArrayUnique } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateFavoritesDto {
  @ApiProperty({
    type: [String],
    example: ['BTC', 'ETH', 'SOL'],
    description: 'Lista de assets favoritos del usuario',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  assets: string[];
}

export class FavoritesResponseDto {
  @ApiProperty({
    type: [String],
    example: ['BTC', 'ETH', 'SOL'],
  })
  favorites: string[];
}

export class ToggleFavoriteResponseDto {
  @ApiProperty({
    type: [String],
    example: ['BTC', 'ETH'],
  })
  favorites: string[];

  @ApiProperty({
    example: true,
    description: 'Estado actual del asset (true = es favorito)',
  })
  isFavorite: boolean;
}

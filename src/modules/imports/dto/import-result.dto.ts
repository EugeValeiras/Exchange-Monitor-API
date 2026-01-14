import { ApiProperty } from '@nestjs/swagger';

export class ImportResultDto {
  @ApiProperty({ example: 150, description: 'Number of transactions imported' })
  imported: number;

  @ApiProperty({ example: 10, description: 'Number of duplicate transactions skipped' })
  skipped: number;

  @ApiProperty({ example: 0, description: 'Number of transactions that failed to import' })
  errors: number;
}

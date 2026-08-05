/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MAX_OUTPUT_SIZE } from './constants';
import { IconError } from './errors';
import { FONT_AWESOME_STYLES, REMIX_ICON_CATEGORIES } from './providers';
import type { SvgIconConfig } from './types';

const ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const REMIX_CATEGORY_SET = new Set<string>(REMIX_ICON_CATEGORIES);
const FONT_AWESOME_STYLE_SET = new Set(FONT_AWESOME_STYLES);

export function validateIconName(iconName: string): void {
  if (!ICON_NAME_PATTERN.test(iconName)) {
    throw new IconError(
      'INVALID_ICON_NAME',
      'iconName must contain only lowercase letters, numbers, hyphens, and underscores',
      {
        stage: 'validation',
        retryable: false,
      },
    );
  }
}

export function validateOutputSize(outputSize: number): void {
  if (!Number.isSafeInteger(outputSize) || outputSize < 1 || outputSize > MAX_OUTPUT_SIZE) {
    throw new IconError('INVALID_OUTPUT_SIZE', `size must be an integer between 1 and ${MAX_OUTPUT_SIZE}`, {
      stage: 'validation',
      retryable: false,
    });
  }
}

export function validateSvgIconConfig(config: SvgIconConfig): void {
  validateIconName(config.iconName);
  validateOutputSize(config.outputSize);

  switch (config.iconType) {
    case 'lucide':
    case 'feather':
      return;

    case 'remix':
      if (!REMIX_CATEGORY_SET.has(config.category)) {
        throw new IconError('INVALID_CONFIG', 'Invalid Remix icon category', {
          stage: 'validation',
          retryable: false,
        });
      }
      return;

    case 'font-awesome':
      if (!FONT_AWESOME_STYLE_SET.has(config.style)) {
        throw new IconError('INVALID_CONFIG', 'Invalid Font Awesome style', {
          stage: 'validation',
          retryable: false,
        });
      }
      return;

    case 'hero':
      if (
        !['16', '20', '24'].includes(config.sourceSize) ||
        !['solid', 'outline'].includes(config.style) ||
        (config.sourceSize !== '24' && config.style !== 'solid')
      ) {
        throw new IconError('INVALID_CONFIG', 'Invalid Heroicons source size and style combination', {
          stage: 'validation',
          retryable: false,
        });
      }
      return;
    default:
      throw new IconError('INVALID_CONFIG', 'Invalid icon type', {
        stage: 'validation',
        retryable: false,
      });
  }
}

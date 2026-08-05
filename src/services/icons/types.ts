/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FontAwesomeStyle, HeroStyle, RemixIconCategory } from './providers';

export type BaseIconConfig = {
  iconName: string;
};

export type SvgIconConfig =
  | {
      iconType: 'lucide' | 'feather';
      iconName: string;
      outputSize: number;
    }
  | {
      iconType: 'remix';
      iconName: string;
      outputSize: number;
      category: RemixIconCategory;
    }
  | {
      iconType: 'font-awesome';
      iconName: string;
      outputSize: number;
      style: FontAwesomeStyle;
    }
  | {
      iconType: 'hero';
      iconName: string;
      outputSize: number;
      sourceSize: '16' | '20';
      style: 'solid';
    }
  | {
      iconType: 'hero';
      iconName: string;
      outputSize: number;
      sourceSize: '24';
      style: HeroStyle;
    };

export type RayfieldIconConfig = {
  iconType: 'rayfield';
  iconName: string;
  assetId: string;
};

export type IconConfig = SvgIconConfig | RayfieldIconConfig;

export type IconLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export type IconOperationContext = {
  /**
   * A request or correlation ID from the API handler.
   * Keep this in logs rather than trace attributes to avoid high cardinality.
   */
  requestId?: string;

  /**
   * Allows tests to inject a logger or disable logs with a no-op logger.
   */
  logger?: IconLogger;

  /** Successful conversions are opt-in because icons can be requested frequently. */
  logSuccess?: boolean;

  /** Controls icon logs and custom trace spans. Defaults to off. */
  reportLevel?: string;
};

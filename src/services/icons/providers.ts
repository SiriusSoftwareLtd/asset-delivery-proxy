/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const REMIX_ICON_CATEGORIES = [
  'Arrows',
  'Buildings',
  'Business',
  'Communication',
  'Design',
  'Development',
  'Device',
  'Document',
  'Editor',
  'Finance',
  'Games & Sports',
  'Health & Medical',
  'Logos',
  'Map',
  'Media',
  'Others',
  'System',
  'User & Faces',
  'Weather',
] as const;

export const FONT_AWESOME_STYLES = ['brands', 'regular', 'solid'] as const;

export const HERO_SOURCE_SIZES = ['16', '20', '24'] as const;

export const HERO_STYLES = ['outline', 'solid'] as const;

export type RemixIconCategory = (typeof REMIX_ICON_CATEGORIES)[number];

export type FontAwesomeStyle = (typeof FONT_AWESOME_STYLES)[number];

export type HeroSourceSize = (typeof HERO_SOURCE_SIZES)[number];

export type HeroStyle = (typeof HERO_STYLES)[number];

export const ICON_PACK_NAMES = ['lucide', 'feather', 'remix', 'font-awesome', 'hero', 'rayfield'] as const;

export type IconPackName = (typeof ICON_PACK_NAMES)[number];

export function isIconPackName(value: string): value is IconPackName {
  return (ICON_PACK_NAMES as readonly string[]).includes(value);
}

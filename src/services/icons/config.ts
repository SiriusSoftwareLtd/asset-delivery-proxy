import type { IconConfig } from './generator';

export type IconPackName = 'lucide' | 'feather' | 'remix' | 'font-awesome' | 'hero';

type IconPackRequest = {
  iconName: string;
  outputSize: number;
  query: URLSearchParams;
};

type IconPackDefinition = {
  toConfig: (request: IconPackRequest) => IconConfig;
};

const PACK_NAMES = ['lucide', 'feather', 'remix', 'font-awesome', 'hero'] as const;
const REMIX_CATEGORIES = [
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
const FONT_AWESOME_STYLES = ['brands', 'regular', 'solid'] as const;
const HERO_SOURCE_SIZES = ['16', '20', '24'] as const;
const HERO_STYLES = ['outline', 'solid'] as const;

function queryValue(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  return value === null ? undefined : value;
}

function requiredQueryValue(query: URLSearchParams, name: string): string {
  const value = queryValue(query, name);

  if (!value) throw new Error(`${name} is required`);
  return value;
}

function asOutputSize(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('size must be an integer between 1 and 1024');

  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1024) {
    throw new Error('size must be an integer between 1 and 1024');
  }

  return size;
}

function asOneOf<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`Invalid ${label}`);
  return value as T[number];
}

const iconPackRegistry: Record<IconPackName, IconPackDefinition> = {
  lucide: { toConfig: ({ iconName, outputSize }) => ({ iconType: 'lucide', iconName, outputSize }) },
  feather: { toConfig: ({ iconName, outputSize }) => ({ iconType: 'feather', iconName, outputSize }) },
  remix: {
    toConfig: ({ iconName, outputSize, query }) => ({
      iconType: 'remix',
      iconName,
      outputSize,
      category: asOneOf(requiredQueryValue(query, 'category'), REMIX_CATEGORIES, 'Remix icon category'),
    }),
  },
  'font-awesome': {
    toConfig: ({ iconName, outputSize, query }) => ({
      iconType: 'font-awesome',
      iconName,
      outputSize,
      style: asOneOf(queryValue(query, 'style') ?? 'solid', FONT_AWESOME_STYLES, 'Font Awesome style'),
    }),
  },
  hero: {
    toConfig: ({ iconName, outputSize, query }) => {
      const sourceSize = asOneOf(queryValue(query, 'sourceSize') ?? '24', HERO_SOURCE_SIZES, 'Heroicons sourceSize');
      const style = asOneOf(queryValue(query, 'style') ?? 'outline', HERO_STYLES, 'Heroicons style');

      if (sourceSize === '24') return { iconType: 'hero', iconName, outputSize, sourceSize, style };
      if (style !== 'solid') throw new Error('Heroicons 16 and 20 source sizes only support solid style');

      return { iconType: 'hero', iconName, outputSize, sourceSize, style };
    },
  },
};

export function isIconPackName(value: string): value is IconPackName {
  return (PACK_NAMES as readonly string[]).includes(value);
}

export function parseIconConfig(
  iconPack: string,
  iconName: string,
  query: URLSearchParams,
): { config: IconConfig; normalizedOptions: string } {
  if (!isIconPackName(iconPack)) throw new Error('Unsupported icon pack');

  const size = asOutputSize(queryValue(query, 'size') ?? '64');
  const config = iconPackRegistry[iconPack].toConfig({ iconName, outputSize: size, query });
  const options = new URLSearchParams(query);
  options.set('size', String(size));

  return { config, normalizedOptions: options.toString() };
}

import { MAX_OUTPUT_SIZE } from './constants';
import { IconError } from './errors';
import {
  FONT_AWESOME_STYLES,
  HERO_SOURCE_SIZES,
  HERO_STYLES,
  type IconPackName,
  isIconPackName,
  REMIX_ICON_CATEGORIES,
} from './providers';
import { resolveRayfieldIconId } from './rayfield';
import type { IconConfig } from './types';
import { validateIconName, validateOutputSize } from './validation';

type IconPackRequest = {
  iconName: string;
  outputSize: number;
  query: URLSearchParams;
};

type SvgIconPackName = Exclude<IconPackName, 'rayfield'>;

type IconPackDefinition = {
  toConfig: (request: IconPackRequest) => IconConfig;
};

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
  if (!/^\d+$/.test(value)) {
    throw new Error(`size must be an integer between 1 and ${MAX_OUTPUT_SIZE}`);
  }

  const size = Number(value);

  validateOutputSize(size);

  return size;
}

function asOneOf<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`Invalid ${label}`);
  return value as T[number];
}

const svgIconPackRegistry: Record<SvgIconPackName, IconPackDefinition> = {
  lucide: {
    toConfig: ({ iconName, outputSize }) => ({
      iconType: 'lucide',
      iconName,
      outputSize,
    }),
  },
  feather: {
    toConfig: ({ iconName, outputSize }) => ({
      iconType: 'feather',
      iconName,
      outputSize,
    }),
  },
  remix: {
    toConfig: ({ iconName, outputSize, query }) => ({
      iconType: 'remix',
      iconName,
      outputSize,
      category: asOneOf(requiredQueryValue(query, 'category'), REMIX_ICON_CATEGORIES, 'Remix icon category'),
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
      if (style !== 'solid')
        throw new IconError('INVALID_CONFIG', 'Heroicons 16 and 20 source sizes only support solid style', {
          stage: 'validation',
          retryable: false,
        });

      return { iconType: 'hero', iconName, outputSize, sourceSize, style };
    },
  },
};

export function parseIconConfig(
  iconPack: string,
  iconName: string,
  query: URLSearchParams,
): { config: IconConfig; normalizedOptions: string; cacheIdentity: string } {
  if (!isIconPackName(iconPack))
    throw new IconError('INVALID_CONFIG', `unknown icon pack ${iconPack}`, {
      stage: 'validation',
      retryable: false,
    });

  validateIconName(iconName);

  if (iconPack === 'rayfield') {
    if (query.size > 0) {
      throw new IconError('INVALID_CONFIG', 'Rayfield icons do not support query options', {
        stage: 'validation',
        retryable: false,
      });
    }

    const assetId = resolveRayfieldIconId(iconName);

    if (!assetId) {
      throw new IconError('ICON_NOT_FOUND', 'The requested icon does not exist', {
        stage: 'validation',
        retryable: false,
      });
    }

    return {
      config: {
        iconType: 'rayfield',
        iconName,
        assetId,
      },
      normalizedOptions: '',
      cacheIdentity: assetId,
    };
  }

  const size = asOutputSize(queryValue(query, 'size') ?? '64');

  const config = svgIconPackRegistry[iconPack].toConfig({
    iconName,
    outputSize: size,
    query,
  });

  const options = new URLSearchParams(query);
  options.set('size', String(size));

  return {
    config,
    normalizedOptions: options.toString(),
    cacheIdentity: iconName,
  };
}

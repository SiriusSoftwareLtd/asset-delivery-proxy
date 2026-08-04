import type { FontAwesomeStyle, RemixIconCategory } from './providers';
import type { SvgIconConfig } from './types';

export function rawGitHubUrl(owner: string, repository: string, ref: string, ...pathSegments: string[]): string {
  const encodedPath = pathSegments.map(encodeURIComponent).join('/');

  return `https://raw.githubusercontent.com/${owner}/${repository}/${encodeURIComponent(ref)}/${encodedPath}`;
}

function getLucideSvgIconUrl(iconName: string): string {
  return rawGitHubUrl('lucide-icons', 'lucide', 'main', 'icons', `${iconName}.svg`);
}

function getRemixIconUrl(category: RemixIconCategory, iconName: string): string {
  return rawGitHubUrl('Remix-Design', 'RemixIcon', 'master', 'icons', category, `${iconName}.svg`);
}

function getFeatherIconUrl(iconName: string): string {
  return rawGitHubUrl('feathericons', 'feather', 'main', 'icons', `${iconName}.svg`);
}

function getHeroIconUrl(sourceSize: '16' | '20' | '24', style: 'outline' | 'solid', iconName: string): string {
  return rawGitHubUrl('tailwindlabs', 'heroicons', 'master', 'optimized', sourceSize, style, `${iconName}.svg`);
}

function getFontAwesomeIconUrl(style: FontAwesomeStyle, iconName: string): string {
  return rawGitHubUrl('FortAwesome', 'Font-Awesome', '7.x', 'svgs', style, `${iconName}.svg`);
}

export function getSvgIconUrl(iconConfig: SvgIconConfig): string {
  switch (iconConfig.iconType) {
    case 'lucide':
      return getLucideSvgIconUrl(iconConfig.iconName);

    case 'remix':
      return getRemixIconUrl(iconConfig.category, iconConfig.iconName);

    case 'feather':
      return getFeatherIconUrl(iconConfig.iconName);

    case 'hero':
      return getHeroIconUrl(iconConfig.sourceSize, iconConfig.style, iconConfig.iconName);

    case 'font-awesome':
      return getFontAwesomeIconUrl(iconConfig.style, iconConfig.iconName);
  }
}

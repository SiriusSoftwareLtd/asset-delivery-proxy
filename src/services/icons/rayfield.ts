import { rawGitHubUrl } from './generator';

const RAYFIELD_ICON_IDS = {
  close: '83277910885129',
  minimise: '108115485663409',
  maximise: '88738500661569',
  settings: '129180860773723',
  search: '100604009889706',
  chevron: '88479147175134',
  check: '125626312718314',
  dot: '91452555903853',
  colorpicker: '91452555903853',
  banner: '111263549366178',
  config: '125823673784681',
  rayfield: '80387863064905',
} as const;

export type RayfieldIconName = keyof typeof RAYFIELD_ICON_IDS;

export function resolveRayfieldIconId(iconName: string): string | undefined {
  return RAYFIELD_ICON_IDS[iconName as RayfieldIconName];
}

function getRayfieldIconUrlFromId(assetId: string): string {
  return rawGitHubUrl('siriusSoftwareLtd', 'rayfield-gen2', 'refs/heads/main', 'assets', `${assetId}.png`);
}

export function getRayfieldIconUrl(iconName: string): string {
  const iconId = resolveRayfieldIconId(iconName);
  if (!iconId) throw new Error(`Icon not found: ${iconName}`);
  return getRayfieldIconUrlFromId(iconId);
}

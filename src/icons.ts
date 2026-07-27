import { Resvg } from "@resvg/resvg-js"

type RemixIconCategories =
	"Arrows" | "Buildings" | "Business" | "Communication"
	| "Design" | "Development" | "Device" | "Document"
	| "Editor" | "Finance" | "Games & Sports" | "Health & Medical"
	| "Logos" | "Map" | "Media" | "Others" | "System" | "User & Faces"
	| "Weather";

const getLucideSvgIconUrl = (iconName: string) => `https://raw.githubusercontent.com/lucide-icons/lucide/refs/heads/main/icons/${iconName}.svg`

const getRemixIconUrl = (iconCategory: RemixIconCategories, iconName: string) => `https://raw.githubusercontent.com/Remix-Design/RemixIcon/refs/heads/master/icons/${iconCategory}/${iconName}.svg`

const getFeatherIconUrl = (iconName: string) => `https://raw.githubusercontent.com/feathericons/feather/refs/heads/main/icons/${iconName}.svg`

const getHeroIconUrl = (size: "16" | "20" | "24", iconName: string) => `https://raw.githubusercontent.com/tailwindlabs/heroicons/refs/heads/master/optimized/${size}${(size == "16" || size == "24") ? "/solid" : ""}/${iconName}.svg`

const getFontAwesomeIconUrl = (style: "brands" | "regular" | "solid", iconName: string) => `https://raw.githubusercontent.com/FortAwesome/Font-Awesome/refs/heads/7.x/svgs/${style}/${iconName}.svg`

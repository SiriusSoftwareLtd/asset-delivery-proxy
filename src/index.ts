import { Context, Hono } from "hono"
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { rateLimit } from "./rateLimiter";

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.use('*', async (c, next) => {
	const rateLimiter = rateLimit(
		c.env.ASSET_PROXY_RATE_LIMITER,
		(c) => c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "anonymous"
	)
	return rateLimiter(c, next)
});

app.get("/assets/:assetId", async (c) => {
	const assetId = c.req.param("assetId")
	const isSecureMode = c.req.header("X-Rayfield-Secure-Mode") === "true"
	const assetCache = c.env.assetCache

	if (!isSecureMode) {
		// proxy request to roblox's asset delivery service
		const robloxAssetUrl = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`
		const robloxResponse = await fetch(robloxAssetUrl)

		if (!robloxResponse.ok) {
			return c.json({ error: "Failed to fetch asset from Roblox" }, 424);
		}

		const robloxData = await robloxResponse.arrayBuffer()
		await assetCache.put(assetId, robloxData)

		return c.body(robloxData, 200, {
			"Content-Type": robloxResponse.headers.get("Content-Type") || "application/octet-stream",
		})
	}
});

export default app

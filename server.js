import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const srcDir = path.join(__dirname, "src");
const dataDir = path.join(__dirname, "data");
const studioUsersPath = path.join(dataDir, "studio-users.json");
const studioReportsPath = path.join(dataDir, "studio-reports.json");

loadEnv(path.join(__dirname, ".env.local"));

const PORT = Number(process.env.PORT || 5173);
const GRAB_BASE_URL = process.env.GRABMAPS_BASE_URL || process.env.VITE_GRABMAPS_BASE_URL || "https://maps.grab.com";
const GRAB_API_KEY = process.env.GRABMAPS_API_KEY || process.env.VITE_GRABMAPS_API_KEY || "";
const GRAB_MCP_URL = process.env.GRABMAPS_MCP_URL || "";
const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const OSM_BASE_URL = process.env.OSM_BASE_URL || "https://www.openstreetmap.org";
const OSM_API_BASE_URL = process.env.OSM_API_BASE_URL || "https://api.openstreetmap.org";
const OSM_OAUTH_CLIENT_ID = process.env.OSM_OAUTH_CLIENT_ID || "";
const OSM_OAUTH_CLIENT_SECRET = process.env.OSM_OAUTH_CLIENT_SECRET || "";
const OSM_OAUTH_REDIRECT_URI = process.env.OSM_OAUTH_REDIRECT_URI || "";
const STUDIO_SUPERADMIN_LOGIN = process.env.STUDIO_SUPERADMIN_LOGIN || process.env.STREET_SMART_SUPERADMIN_LOGIN || "";
const STUDIO_SUPERADMIN_PASSWORD = process.env.STUDIO_SUPERADMIN_PASSWORD || process.env.STREET_SMART_SUPERADMIN_PASSWORD || "";
const hasDisplayGrabKey = Boolean(GRAB_API_KEY && !GRAB_API_KEY.startsWith("mcp_"));
let grabResourceQueue = Promise.resolve();
const studioSessions = new Map();
const STUDIO_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/config") {
      return sendJson(res, {
        hasGrabKey: Boolean(GRAB_API_KEY),
        hasDirectGrabKey: Boolean(GRAB_API_KEY && !GRAB_API_KEY.startsWith("mcp_")),
        isMcpRouting: shouldUseMcp(),
        mapStyleUrl: "/api/map-style",
        defaultCenter: { lat: 1.2966, lng: 103.852 },
        country: "SGP",
        osmOAuth: {
          configured: Boolean(OSM_OAUTH_CLIENT_ID),
          clientId: OSM_OAUTH_CLIENT_ID,
          redirectUri: OSM_OAUTH_REDIRECT_URI,
          authUrl: `${OSM_BASE_URL}/oauth2/authorize`,
          scopes: "read_prefs write_api"
        },
        studioAuth: {
          superadminConfigured: Boolean(STUDIO_SUPERADMIN_LOGIN && STUDIO_SUPERADMIN_PASSWORD)
        }
      });
    }

    if (requestUrl.pathname === "/api/map-style") {
      return sendMapStyle(res, requestUrl);
    }

    if (requestUrl.pathname === "/api/osm-style") {
      return sendJson(res, osmRasterStyle(requestUrl));
    }

    if (requestUrl.pathname === "/api/grab-resource" || requestUrl.pathname === "/api/grab-resource.json" || requestUrl.pathname === "/api/grab-resource.png") {
      return proxyGrabResource(res, requestUrl);
    }

    if (requestUrl.pathname === "/api/search") {
      const keyword = requestUrl.searchParams.get("keyword")?.trim();
      if (!keyword) return sendJson(res, { places: [] });

      if (shouldUseMcp()) {
        try {
          const location = parseLocation(requestUrl.searchParams.get("location"));
          const limit = Number(requestUrl.searchParams.get("limit") || "8");
          const payload = await callMcpTool("search", {
            keyword,
            country: requestUrl.searchParams.get("country") || "SGP",
            location,
            limit: Number.isFinite(limit) ? limit : 8
          });
          if (hasSearchResults(payload)) return sendJson(res, payload);
        } catch (error) {
          console.warn(`GrabMaps MCP search failed, falling back to Nominatim: ${error.message}`);
        }
        return sendJson(res, await searchNominatim(requestUrl));
      }

      const upstream = new URL("/api/v1/maps/poi/v1/search", GRAB_BASE_URL);
      copyParams(requestUrl.searchParams, upstream.searchParams, ["keyword", "country", "location", "limit", "language"]);
      if (!upstream.searchParams.has("country")) upstream.searchParams.set("country", "SGP");
      if (!upstream.searchParams.has("limit")) upstream.searchParams.set("limit", "8");
      try {
        const payload = await fetchGrabJsonData(upstream);
        if (hasSearchResults(payload)) return sendJson(res, payload);
      } catch (error) {
        console.warn(`GrabMaps search failed, falling back to Nominatim: ${error.message}`);
      }
      return sendJson(res, await searchNominatim(requestUrl));
    }

    if (requestUrl.pathname === "/api/route") {
      const coordinates = getRouteCoordinates(requestUrl);
      if (coordinates.length < 2) {
        return sendJson(res, { error: "At least two coordinates are required." }, 400);
      }

      const profile = normalizeProfile(requestUrl.searchParams.get("profile"));
      const provider = normalizeRouteProvider(requestUrl.searchParams.get("provider"));
      const payload = await fetchRoute(coordinates, profile, provider);
      if (payload?.error) return sendJson(res, payload, 502);
      return sendJson(res, payload);
    }

    if (requestUrl.pathname === "/api/nearby") {
      const location = requestUrl.searchParams.get("location");
      if (!location) return sendJson(res, { places: [] }, 400);

      const upstream = new URL("/api/v1/maps/place/v2/nearby", GRAB_BASE_URL);
      copyParams(requestUrl.searchParams, upstream.searchParams, ["location", "radius", "limit", "rankBy", "language"]);
      if (!upstream.searchParams.has("radius")) upstream.searchParams.set("radius", "1");
      if (!upstream.searchParams.has("limit")) upstream.searchParams.set("limit", "10");
      if (!upstream.searchParams.has("rankBy")) upstream.searchParams.set("rankBy", "distance");
      return proxyGrabJson(res, upstream);
    }

    if (requestUrl.pathname === "/api/reverse") {
      const location = requestUrl.searchParams.get("location");
      if (!location) return sendJson(res, { error: "location is required" }, 400);

      const upstream = new URL("/api/v1/maps/poi/v1/reverse-geo", GRAB_BASE_URL);
      copyParams(requestUrl.searchParams, upstream.searchParams, ["location", "type", "language"]);
      return proxyGrabJson(res, upstream);
    }

    if (requestUrl.pathname === "/api/osm/oauth/token") {
      if (req.method !== "POST") return sendJson(res, { error: "POST required." }, 405);
      return exchangeOsmToken(req, res);
    }

    if (requestUrl.pathname === "/api/osm/me") {
      return fetchOsmUser(req, res);
    }

    if (requestUrl.pathname === "/api/studio/auth/login") {
      if (req.method !== "POST") return sendJson(res, { error: "POST required." }, 405);
      return loginStudioUser(req, res);
    }

    if (requestUrl.pathname === "/api/studio/auth/register") {
      if (req.method !== "POST") return sendJson(res, { error: "POST required." }, 405);
      return registerStudioUser(req, res);
    }

    if (requestUrl.pathname === "/api/studio/auth/reset-password") {
      if (req.method !== "POST") return sendJson(res, { error: "POST required." }, 405);
      return resetStudioPassword(req, res);
    }

    if (requestUrl.pathname === "/api/studio/auth/logout") {
      if (req.method !== "POST") return sendJson(res, { error: "POST required." }, 405);
      return logoutStudioUser(req, res);
    }

    if (requestUrl.pathname === "/api/studio/auth/me") {
      if (req.method !== "GET") return sendJson(res, { error: "GET required." }, 405);
      return getStudioSession(req, res);
    }

    if (requestUrl.pathname === "/api/studio/admins") {
      if (req.method === "GET") return listStudioAdmins(req, res);
      if (req.method === "POST") return addStudioAdmin(req, res);
      return sendJson(res, { error: "GET or POST required." }, 405);
    }

    if (requestUrl.pathname.startsWith("/api/studio/admins/")) {
      if (req.method !== "DELETE") return sendJson(res, { error: "DELETE required." }, 405);
      const adminId = decodeURIComponent(requestUrl.pathname.slice("/api/studio/admins/".length));
      return removeStudioAdmin(req, res, adminId);
    }

    if (requestUrl.pathname === "/api/studio/reports") {
      if (req.method === "GET") return listStudioReports(req, res);
      if (req.method === "POST") return createStudioReport(req, res);
      return sendJson(res, { error: "GET or POST required." }, 405);
    }

    if (requestUrl.pathname.startsWith("/api/studio/reports/")) {
      const reportId = decodeURIComponent(requestUrl.pathname.slice("/api/studio/reports/".length));
      if (req.method === "PATCH") return updateStudioReport(req, res, reportId);
      if (req.method !== "DELETE") return sendJson(res, { error: "PATCH or DELETE required." }, 405);
      return deleteStudioReport(req, res, reportId);
    }

    return serveStatic(res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: "Internal server error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Street Smart running at http://localhost:${PORT}`);
});

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function copyParams(from, to, keys) {
  for (const key of keys) {
    const value = from.get(key);
    if (value !== null && value !== "") to.set(key, value);
  }
}

async function proxyGrabJson(res, upstreamUrl) {
  try {
    const payload = await fetchGrabJsonData(upstreamUrl);
    return sendJson(res, payload);
  } catch (error) {
    return sendJson(res, { error: error.message }, 502);
  }
}

async function fetchGrabJsonData(upstreamUrl) {
  if (!GRAB_API_KEY) {
    throw new Error("GrabMaps API key is not configured. Add GRABMAPS_API_KEY to .env.local.");
  }

  const upstreamRes = await fetch(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${GRAB_API_KEY}`,
      Accept: "application/json"
    }
  });

  const body = await upstreamRes.text();
  const payload = parseJsonBody(body) || { error: body || `GrabMaps API returned status ${upstreamRes.status}` };
  if (!upstreamRes.ok) {
    throw new Error(payload?.error || `GrabMaps API returned status ${upstreamRes.status}`);
  }
  return payload;
}

async function exchangeOsmToken(req, res) {
  if (!OSM_OAUTH_CLIENT_ID) {
    return sendJson(res, { error: "OSM OAuth is not configured. Add OSM_OAUTH_CLIENT_ID to .env.local." }, 400);
  }

  try {
    const body = await readJsonBody(req);
    const code = String(body.code || "");
    const codeVerifier = String(body.codeVerifier || "");
    const redirectUri = String(body.redirectUri || OSM_OAUTH_REDIRECT_URI || "");
    if (!code || !codeVerifier || !redirectUri) {
      return sendJson(res, { error: "code, codeVerifier, and redirectUri are required." }, 400);
    }

    const payload = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OSM_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier
    });
    if (OSM_OAUTH_CLIENT_SECRET) payload.set("client_secret", OSM_OAUTH_CLIENT_SECRET);

    const response = await fetch(`${OSM_BASE_URL}/oauth2/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: payload
    });
    const text = await response.text();
    const data = parseJsonBody(text) || { error: text || `OpenStreetMap token endpoint returned status ${response.status}` };
    if (!response.ok) return sendJson(res, { error: data.error_description || data.error || `OpenStreetMap token endpoint returned status ${response.status}` }, 502);
    return sendJson(res, data);
  } catch (error) {
    return sendJson(res, { error: error.message || "OpenStreetMap login failed." }, 502);
  }
}

async function fetchOsmUser(req, res) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return sendJson(res, { error: "Bearer token required." }, 401);
  }

  try {
    const response = await fetch(`${OSM_API_BASE_URL}/api/0.6/user/details.json`, {
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "User-Agent": "StreetSmartPrototype/0.1"
      }
    });
    const text = await response.text();
    const data = parseJsonBody(text) || { error: text || `OpenStreetMap user endpoint returned status ${response.status}` };
    if (!response.ok) return sendJson(res, { error: data.error || `OpenStreetMap user endpoint returned status ${response.status}` }, response.status);
    return sendJson(res, data);
  } catch (error) {
    return sendJson(res, { error: error.message || "Could not fetch OpenStreetMap user." }, 502);
  }
}

async function loginStudioUser(req, res) {
  try {
    const body = await readJsonBody(req);
    const login = normalizeStudioIdentity(body.login || body.email || body.username);
    const password = String(body.password || "");
    if (!login || !password) return sendJson(res, { error: "Username/email and password are required." }, 400);

    const superadmin = getConfiguredSuperadmin();
    if (superadmin && normalizedLoginMatches(STUDIO_SUPERADMIN_LOGIN, login) && safeTextEqual(password, STUDIO_SUPERADMIN_PASSWORD)) {
      return sendJson(res, { session: createStudioSession(superadmin) });
    }

    const users = await readStudioUsers();
    const user = users.find((candidate) => studioUserMatches(candidate, login));
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return sendJson(res, { error: "Invalid username/email or password." }, 401);
    }
    return sendJson(res, { session: createStudioSession(user) });
  } catch (error) {
    return sendJson(res, { error: error.message || "Login failed." }, 400);
  }
}

async function registerStudioUser(req, res) {
  try {
    const body = await readJsonBody(req);
    const login = normalizeStudioIdentity(body.login || body.email || body.username);
    const password = String(body.password || "");
    if (!login) return sendJson(res, { error: "Choose a username or email." }, 400);
    if (password.length < 8) return sendJson(res, { error: "Password must be at least 8 characters." }, 400);
    if (normalizedLoginMatches(STUDIO_SUPERADMIN_LOGIN, login)) {
      return sendJson(res, { error: "That login is reserved for the superadmin." }, 409);
    }

    const users = await readStudioUsers();
    const user = createStoredStudioUser(body, "user");
    if (users.some((candidate) => studioUserConflicts(candidate, user))) {
      return sendJson(res, { error: "An account with that username or email already exists." }, 409);
    }

    users.push(user);
    await writeStudioUsers(users);
    return sendJson(res, { session: createStudioSession(user) }, 201);
  } catch (error) {
    return sendJson(res, { error: error.message || "Could not create account." }, 400);
  }
}

async function resetStudioPassword(req, res) {
  try {
    const body = await readJsonBody(req);
    const login = normalizeStudioIdentity(body.login || body.email || body.username);
    const currentPassword = String(body.currentPassword || body.oldPassword || "");
    const password = String(body.password || body.newPassword || "");
    if (!login || password.length < 8) {
      return sendJson(res, { error: "Enter the account username/email and a new password of at least 8 characters." }, 400);
    }
    if (!currentPassword) return sendJson(res, { error: "Current password is required in this local build." }, 400);

    if (!normalizedLoginMatches(STUDIO_SUPERADMIN_LOGIN, login)) {
      const users = await readStudioUsers();
      const user = users.find((candidate) => studioUserMatches(candidate, login));
      if (user) {
        if (!verifyPassword(currentPassword, user.passwordHash)) {
          return sendJson(res, { error: "Current password is incorrect." }, 401);
        }
        user.passwordHash = hashPassword(password);
        user.updatedAt = new Date().toISOString();
        await writeStudioUsers(users);
      }
    }

    return sendJson(res, {
      ok: true,
      message: "Password updated if that local account exists. Superadmin credentials are changed in .env.local."
    });
  } catch (error) {
    return sendJson(res, { error: error.message || "Password reset failed." }, 400);
  }
}

async function logoutStudioUser(req, res) {
  const token = bearerToken(req);
  if (token) studioSessions.delete(token);
  return sendJson(res, { ok: true });
}

async function getStudioSession(req, res) {
  const user = await studioUserFromRequest(req);
  if (!user) return sendJson(res, { user: null }, 401);
  return sendJson(res, { user });
}

async function listStudioAdmins(req, res) {
  const user = await requireStudioRole(req, res, ["superadmin"]);
  if (!user) return;
  return sendJson(res, await studioAdminPayload());
}

async function addStudioAdmin(req, res) {
  const actor = await requireStudioRole(req, res, ["superadmin"]);
  if (!actor) return;

  try {
    const body = await readJsonBody(req);
    const login = normalizeStudioIdentity(body.login || body.email || body.username);
    const password = String(body.password || "");
    if (!login) return sendJson(res, { error: "Enter the admin username or email." }, 400);
    if (normalizedLoginMatches(STUDIO_SUPERADMIN_LOGIN, login)) {
      return sendJson(res, { error: "The env-backed superadmin is already an administrator." }, 409);
    }

    const users = await readStudioUsers();
    let user = users.find((candidate) => studioUserMatches(candidate, login));
    if (!user) {
      if (password.length < 8) return sendJson(res, { error: "New admins need an initial password of at least 8 characters." }, 400);
      user = createStoredStudioUser(body, "admin");
      if (users.some((candidate) => studioUserConflicts(candidate, user))) {
        return sendJson(res, { error: "An account with that username or email already exists." }, 409);
      }
      users.push(user);
    } else {
      user.role = "admin";
      user.updatedAt = new Date().toISOString();
      if (password) {
        if (password.length < 8) return sendJson(res, { error: "Password must be at least 8 characters." }, 400);
        user.passwordHash = hashPassword(password);
      }
    }

    await writeStudioUsers(users);
    return sendJson(res, await studioAdminPayload(), 201);
  } catch (error) {
    return sendJson(res, { error: error.message || "Could not add admin." }, 400);
  }
}

async function removeStudioAdmin(req, res, adminId) {
  const actor = await requireStudioRole(req, res, ["superadmin"]);
  if (!actor) return;
  if (!adminId || adminId === "superadmin") {
    return sendJson(res, { error: "The env-backed superadmin cannot be removed here." }, 400);
  }

  const users = await readStudioUsers();
  const user = users.find((candidate) => candidate.id === adminId);
  if (!user || user.role !== "admin") return sendJson(res, { error: "Admin not found." }, 404);
  user.role = "user";
  user.updatedAt = new Date().toISOString();
  await writeStudioUsers(users);
  return sendJson(res, await studioAdminPayload());
}

async function listStudioReports(req, res) {
  return sendJson(res, { reports: await readStudioReports() });
}

async function createStudioReport(req, res) {
  try {
    const body = await readJsonBody(req);
    const report = normalizeStudioReport(body.report || body);
    if (!report) return sendJson(res, { error: "Report requires a valid latitude and longitude." }, 400);

    const reports = await readStudioReports();
    const nextReports = [report, ...reports.filter((item) => item.id !== report.id)].slice(0, 500);
    await writeStudioReports(nextReports);
    return sendJson(res, { report, reports: nextReports }, 201);
  } catch (error) {
    return sendJson(res, { error: error.message || "Could not save report." }, 400);
  }
}

async function deleteStudioReport(req, res, reportId) {
  const actor = await requireStudioRole(req, res, ["admin", "superadmin"]);
  if (!actor) return;
  const reports = await readStudioReports();
  const nextReports = reports.filter((report) => report.id !== reportId);
  if (nextReports.length === reports.length) return sendJson(res, { error: "Report not found." }, 404);
  await writeStudioReports(nextReports);
  return sendJson(res, { reports: nextReports });
}

async function updateStudioReport(req, res, reportId) {
  const actor = await studioUserFromRequest(req);
  if (!actor) return sendJson(res, { error: "Studio login required." }, 401);

  try {
    const body = await readJsonBody(req);
    const reports = await readStudioReports();
    const index = reports.findIndex((report) => report.id === reportId);
    if (index === -1) return sendJson(res, { error: "Report not found." }, 404);

    const merged = normalizeStudioReport({
      ...reports[index],
      ...body.report,
      id: reportId,
      updatedAt: new Date().toISOString(),
      updatedBy: actor.displayName || actor.username || actor.email
    });
    if (!merged) return sendJson(res, { error: "Report update requires a valid latitude and longitude." }, 400);
    reports[index] = merged;
    await writeStudioReports(reports);
    return sendJson(res, { report: merged, reports });
  } catch (error) {
    return sendJson(res, { error: error.message || "Could not update report." }, 400);
  }
}

async function requireStudioRole(req, res, roles) {
  const user = await studioUserFromRequest(req);
  if (!user) {
    sendJson(res, { error: "Studio login required." }, 401);
    return null;
  }
  if (!roles.includes(user.role)) {
    sendJson(res, { error: "You do not have permission for this Studio action." }, 403);
    return null;
  }
  return user;
}

async function studioUserFromRequest(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const session = studioSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    studioSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + STUDIO_SESSION_TTL_MS;
  if (session.superadmin) return getConfiguredSuperadmin();

  const users = await readStudioUsers();
  const user = users.find((candidate) => candidate.id === session.userId);
  return user ? publicStudioUser(user) : null;
}

function createStudioSession(user) {
  const token = randomBytes(32).toString("base64url");
  const isSuperadmin = user.role === "superadmin";
  studioSessions.set(token, {
    userId: user.id,
    superadmin: isSuperadmin,
    expiresAt: Date.now() + STUDIO_SESSION_TTL_MS
  });
  return {
    token,
    user: publicStudioUser(user)
  };
}

function bearerToken(req) {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function getConfiguredSuperadmin() {
  if (!STUDIO_SUPERADMIN_LOGIN || !STUDIO_SUPERADMIN_PASSWORD) return null;
  const login = STUDIO_SUPERADMIN_LOGIN.trim();
  const isEmail = login.includes("@");
  return {
    id: "superadmin",
    username: isEmail ? "superadmin" : login,
    email: isEmail ? login : "",
    displayName: login,
    role: "superadmin",
    createdAt: null
  };
}

async function studioAdminPayload() {
  const superadmin = getConfiguredSuperadmin();
  const users = await readStudioUsers();
  const admins = [
    ...(superadmin ? [{ ...publicStudioUser(superadmin), removable: false }] : []),
    ...users
      .filter((user) => user.role === "admin")
      .map((user) => ({ ...publicStudioUser(user), removable: true }))
  ];
  return { admins };
}

function createStoredStudioUser(body, role) {
  const login = normalizeStudioIdentity(body.login || body.email || body.username);
  if (!login) throw new Error("Username or email is required.");
  const isEmail = login.includes("@");
  const email = normalizeStudioIdentity(body.email || (isEmail ? login : ""));
  const username = sanitizeStudioUsername(body.username || (!isEmail ? login : login.split("@")[0]));
  const password = String(body.password || "");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  return {
    id: randomUUID(),
    username,
    email,
    displayName: String(body.displayName || username || email).trim().slice(0, 80),
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };
}

function publicStudioUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || "",
    displayName: user.displayName || user.username || user.email,
    role: user.role || "user",
    createdAt: user.createdAt || null
  };
}

async function readStudioUsers() {
  const data = await readJsonFile(studioUsersPath, { users: [] });
  return Array.isArray(data.users) ? data.users : [];
}

async function writeStudioUsers(users) {
  await writeJsonFile(studioUsersPath, { users });
}

async function readStudioReports() {
  const data = await readJsonFile(studioReportsPath, { reports: [] });
  return Array.isArray(data.reports) ? data.reports.map(normalizeStudioReport).filter(Boolean) : [];
}

async function writeStudioReports(reports) {
  await writeJsonFile(studioReportsPath, { reports });
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function studioUserMatches(user, login) {
  const normalizedLogin = normalizeStudioIdentity(login);
  return normalizedLogin
    && (
      normalizeStudioIdentity(user.username) === normalizedLogin
      || normalizeStudioIdentity(user.email) === normalizedLogin
    );
}

function studioUserConflicts(existing, nextUser) {
  return Boolean(
    normalizeStudioIdentity(existing.username) && normalizeStudioIdentity(existing.username) === normalizeStudioIdentity(nextUser.username)
  ) || Boolean(
    normalizeStudioIdentity(existing.email) && normalizeStudioIdentity(nextUser.email) && normalizeStudioIdentity(existing.email) === normalizeStudioIdentity(nextUser.email)
  );
}

function normalizedLoginMatches(candidate, login) {
  return Boolean(candidate && login && normalizeStudioIdentity(candidate) === normalizeStudioIdentity(login));
}

function normalizeStudioIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeStudioUsername(value) {
  const username = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return username.length >= 3 ? username.slice(0, 40) : `user-${randomBytes(3).toString("hex")}`;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash = "") {
  const [salt, hash] = String(storedHash).split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeStudioReport(report) {
  if (!report || typeof report !== "object") return null;
  const deviation = normalizeReportDeviation(report.deviation);
  const point = reportPoint(report, deviation);
  if (!point) return null;
  const [lng, lat] = point;

  return {
    id: String(report.id || randomUUID()),
    type: String(report.type || "Report").slice(0, 100),
    context: String(report.context || "").slice(0, 240),
    mode: String(report.mode || "").slice(0, 40),
    lat,
    lng,
    createdAt: validIsoDate(report.createdAt) ? report.createdAt : new Date().toISOString(),
    createdBy: report.createdBy ? String(report.createdBy).slice(0, 100) : "",
    updatedAt: validIsoDate(report.updatedAt) ? report.updatedAt : null,
    updatedBy: report.updatedBy ? String(report.updatedBy).slice(0, 100) : "",
    deviation,
    editorDraft: normalizeEditorDraft(report.editorDraft)
  };
}

function normalizeReportDeviation(deviation) {
  if (!deviation || typeof deviation !== "object") return null;
  return {
    point: isLngLatPoint(deviation.point) ? deviation.point : null,
    suggestedLine: Array.isArray(deviation.suggestedLine) ? deviation.suggestedLine.filter(isLngLatPoint) : [],
    actualLine: Array.isArray(deviation.actualLine) ? deviation.actualLine.filter(isLngLatPoint) : []
  };
}

function reportPoint(report, deviation = normalizeReportDeviation(report?.deviation)) {
  const lat = Number(report?.lat ?? report?.location?.lat);
  const lng = Number(report?.lng ?? report?.location?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return [lng, lat];
  if (isLngLatPoint(deviation?.point)) return deviation.point;
  if (Array.isArray(deviation?.actualLine) && deviation.actualLine.length) return deviation.actualLine.at(-1);
  if (Array.isArray(deviation?.suggestedLine) && deviation.suggestedLine.length) return deviation.suggestedLine.at(-1);
  return null;
}

function isLngLatPoint(point) {
  return Array.isArray(point)
    && point.length >= 2
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]));
}

function normalizeEditorDraft(draft) {
  if (!draft || typeof draft !== "object") return null;
  const nodes = Array.isArray(draft.nodes) ? draft.nodes.filter(isLngLatPoint).slice(0, 500) : [];
  const mode = ["node", "road", "area"].includes(draft.mode) ? draft.mode : "road";
  const geometryType = mode === "area" ? "Polygon" : mode === "node" ? "MultiPoint" : "LineString";
  return {
    mode,
    geometryType,
    nodes
  };
}

function validIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function searchNominatim(requestUrl) {
  const keyword = requestUrl.searchParams.get("keyword")?.trim() || "";
  const limit = Number(requestUrl.searchParams.get("limit") || "8");
  const location = parseLocation(requestUrl.searchParams.get("location"));
  const upstream = new URL("https://nominatim.openstreetmap.org/search");
  upstream.searchParams.set("q", keyword);
  upstream.searchParams.set("format", "jsonv2");
  upstream.searchParams.set("addressdetails", "1");
  upstream.searchParams.set("limit", String(Number.isFinite(limit) ? Math.min(limit, 50) : 8));
  upstream.searchParams.set("accept-language", requestUrl.searchParams.get("language") || "en");
  if (location) {
    const delta = 0.18;
    upstream.searchParams.set("viewbox", [
      location.longitude - delta,
      location.latitude + delta,
      location.longitude + delta,
      location.latitude - delta
    ].join(","));
    upstream.searchParams.set("bounded", "0");
  }

  const response = await fetch(upstream, {
    headers: {
      Accept: "application/json",
      "User-Agent": "StreetSmartPrototype/0.1 (local development fallback)"
    }
  });
  const text = await response.text();
  const results = parseJsonBody(text);
  if (!response.ok || !Array.isArray(results)) {
    return { places: [], provider: "nominatim", error: `Nominatim search returned status ${response.status}` };
  }

  return {
    provider: "nominatim",
    places: results.map((place) => ({
      id: `nominatim-${place.place_id || place.osm_id}`,
      name: place.name || place.display_name?.split(",")[0] || "Unnamed place",
      address: place.display_name || "",
      category: place.type || place.class || "",
      location: {
        lat: Number(place.lat),
        lng: Number(place.lon)
      },
      raw: place
    }))
  };
}

function hasSearchResults(payload) {
  const results = payload?.places || payload?.results || [];
  return Array.isArray(results) && results.length > 0;
}

async function fetchRoute(coordinates, profile, preferredProvider = "grab") {
  const errors = [];
  const providers = preferredProvider === "osrm" ? ["osrm", "grab"] : ["grab", "osrm"];

  for (const provider of providers) {
    if (provider === "osrm") {
      const payload = await fetchOsrmRoute(coordinates, profile, errors);
      if (!payload?.error && hasRouteResults(payload)) return enrichOsrmWithGrabTraffic(payload, coordinates, profile);
      if (payload?.error) errors.push(payload.error);
      continue;
    }

    try {
      const payload = await fetchGrabRoute(coordinates, profile);
      if (!payload?.error && hasRouteResults(payload)) return payload;
      errors.push(payload?.error || "Grab routing returned no route.");
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    error: [
      "Routing failed for the selected provider and fallback provider.",
      ...errors
    ].filter(Boolean).join(" ")
  };
}

async function fetchGrabRoute(coordinates, profile) {
  if (shouldUseMcp()) {
      const payload = await callMcpTool("navigation", {
        profile,
        coordinates,
        geometries: "polyline6",
        overview: "full",
        steps: true
      });
      if (!payload?.error && hasRouteResults(payload)) return stampRoutePayload(payload, "grabmaps", profile);
      throw new Error(payload?.error || "GrabMaps MCP returned no route.");
  }

  const upstream = new URL("/api/v1/maps/eta/v1/direction", GRAB_BASE_URL);
  coordinates.forEach(({ latitude, longitude }) => {
    upstream.searchParams.append("coordinates", `${latitude},${longitude}`);
  });
  upstream.searchParams.set("profile", profile);
  upstream.searchParams.set("lat_first", "true");
  upstream.searchParams.set("geometries", "polyline6");
  upstream.searchParams.set("overview", "full");
  upstream.searchParams.set("steps", "true");
  upstream.searchParams.set("alternatives", "true");

  if (!GRAB_API_KEY) {
    throw new Error("GrabMaps API key is not configured.");
  }

  const upstreamRes = await fetch(upstream, {
    headers: {
      Authorization: `Bearer ${GRAB_API_KEY}`,
      Accept: "application/json"
    }
  });
  const body = await upstreamRes.text();
  const data = parseJsonBody(body) || { error: body || `Grab routing API returned status ${upstreamRes.status}` };
  if (!upstreamRes.ok) throw new Error(data?.error || `Grab routing API returned status ${upstreamRes.status}`);
  if (hasRouteResults(data)) return stampRoutePayload(data, "grabmaps", profile);
  throw new Error("Grab routing returned no route.");
}

async function fetchOsrmRoute(coordinates, profile, priorErrors = []) {
  const coordinateText = coordinates
    .map(({ latitude, longitude }) => `${longitude},${latitude}`)
    .join(";");
  const attempts = osrmProfilesFor(profile);
  const errors = [];

  for (const osrmProfile of attempts) {
    const upstream = new URL(`/route/v1/${osrmProfile}/${coordinateText}`, OSRM_BASE_URL);
    upstream.searchParams.set("overview", "full");
    upstream.searchParams.set("geometries", "geojson");
    upstream.searchParams.set("steps", "true");
    upstream.searchParams.set("annotations", "duration,distance,speed");
    upstream.searchParams.set("alternatives", "true");

    try {
      const response = await fetch(upstream, {
        headers: {
          Accept: "application/json",
          "User-Agent": "StreetSmartPrototype/0.1 (local development fallback)"
        }
      });
      const text = await response.text();
      const data = parseJsonBody(text) || {};
      if (!response.ok || data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
        errors.push(`${osrmProfile}: ${data.message || data.code || response.status}`);
        continue;
      }
      return normalizeOsrmPayload(data, osrmProfile, priorErrors);
    } catch (error) {
      errors.push(`${osrmProfile}: ${error.message}`);
    }
  }

  return {
    error: [
      "Grab routing failed and OSRM fallback could not find a route.",
      ...priorErrors,
      ...errors
    ].filter(Boolean).join(" ")
  };
}

async function enrichOsrmWithGrabTraffic(osrmPayload, coordinates, profile) {
  try {
    const grabPayload = await fetchGrabRoute(coordinates, profile);
    const grabRoute = Array.isArray(grabPayload?.routes) ? grabPayload.routes[0] : null;
    if (!grabRoute) return osrmPayload;

    return {
      ...osrmPayload,
      trafficProvider: "grabmaps",
      routes: osrmPayload.routes.map((route) => ({
        ...route,
        trafficProvider: "grabmaps",
        traffic: {
          provider: "grabmaps",
          distance: grabRoute.distance ?? grabRoute.distanceMeters,
          duration: grabRoute.duration ?? grabRoute.durationSeconds,
          legs: Array.isArray(grabRoute.legs) ? grabRoute.legs : [],
          steps: extractTrafficSteps(grabRoute)
        }
      }))
    };
  } catch (error) {
    return {
      ...osrmPayload,
      trafficError: error.message
    };
  }
}

function extractTrafficSteps(route) {
  const steps = [
    route.steps,
    route.legs?.flatMap((leg) => leg.steps || []),
    route.legs?.flatMap((leg) => leg.maneuvers || [])
  ].find((candidate) => Array.isArray(candidate) && candidate.length);
  return Array.isArray(steps) ? steps : [];
}

function normalizeOsrmPayload(data, profile, priorErrors) {
  return {
    provider: "osrm",
    fallback: {
      provider: "OSRM",
      profile,
      reason: priorErrors.filter(Boolean).join(" ")
    },
    routes: data.routes.map((route, index) => ({
      id: `osrm-${index}`,
      profile,
      distance: route.distance,
      duration: route.duration,
      geometry: route.geometry?.coordinates || [],
      annotations: route.legs?.length === 1 ? route.legs[0].annotation : null,
      legs: (route.legs || []).map((leg) => ({
        distance: leg.distance,
        duration: leg.duration,
        annotations: leg.annotation || null,
        steps: (leg.steps || []).map((step, stepIndex) => ({
          id: `osrm-${index}-${stepIndex}`,
          instruction: instructionForOsrmStep(step),
          distance: step.distance,
          duration: step.duration,
          maneuver: step.maneuver?.modifier || step.maneuver?.type || ""
        }))
      }))
    }))
  };
}

function instructionForOsrmStep(step) {
  const type = step.maneuver?.type || "continue";
  const modifier = step.maneuver?.modifier || "";
  const name = step.name || "the road";
  if (type === "depart") return `Head ${modifier || "out"} on ${name}`;
  if (type === "arrive") return "Arrive at your destination";
  if (type === "turn") return `Turn ${modifier} onto ${name}`.replace(/\s+/g, " ").trim();
  if (type === "roundabout") return `Enter the roundabout toward ${name}`;
  if (type === "merge") return `Merge ${modifier} onto ${name}`.replace(/\s+/g, " ").trim();
  if (type === "fork") return `Keep ${modifier} toward ${name}`.replace(/\s+/g, " ").trim();
  return `Continue on ${name}`;
}

function osrmProfilesFor(profile) {
  if (profile === "walking") return ["foot", "walking"];
  if (profile === "cycling") return ["bike", "cycling"];
  return ["driving"];
}

function hasRouteResults(payload) {
  return Array.isArray(payload?.routes) && payload.routes.length > 0;
}

function stampRoutePayload(payload, provider, profile) {
  if (!Array.isArray(payload?.routes)) return payload;
  return {
    ...payload,
    provider,
    profile,
    routes: payload.routes.map((route) => ({
      ...route,
      provider,
      profile
    }))
  };
}

async function sendMapStyle(res, requestUrl) {
  if (!GRAB_API_KEY || GRAB_API_KEY.startsWith("mcp_")) {
    return sendJson(res, blankMapStyle("Add a direct GrabMaps display API key to .env.local to load the GrabMaps basemap."));
  }

  const theme = normalizeGrabStyleTheme(requestUrl.searchParams.get("theme"));
  const stylePaths = [
    `/api/style.json?theme=${theme}`,
    `/api/v1/api/style.json?theme=${theme}`,
    ...(theme === "basic" ? ["/api/style.json", "/api/v1/api/style.json"] : [])
  ];
  const errors = [];
  for (const stylePath of stylePaths) {
    const upstream = new URL(stylePath, GRAB_BASE_URL);
    const response = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${GRAB_API_KEY}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();
    if (!response.ok) {
      errors.push(`${upstream.pathname}${upstream.search}: ${response.status} ${text.trim()}`);
      continue;
    }

    try {
      const style = JSON.parse(text);
      return sendJson(res, rewriteStyleUrls(style, requestUrl));
    } catch {
      return sendJson(res, blankMapStyle("GrabMaps style response was not valid JSON."));
    }
  }

  return sendJson(res, blankMapStyle(`GrabMaps style endpoint rejected the configured key. ${errors[0] || ""}`.trim()));
}

function normalizeGrabStyleTheme(theme) {
  return ["basic", "dark", "satellite"].includes(theme) ? theme : "basic";
}

async function proxyGrabResource(res, requestUrl) {
  if (!hasDisplayGrabKey) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("A direct GrabMaps display API key is required.");
  }

  const target = requestUrl.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    return res.end("url is required");
  }

  const targetUrl = new URL(target, GRAB_BASE_URL);
  if (requestUrl.pathname.endsWith(".json") || requestUrl.pathname.endsWith(".png")) {
    targetUrl.pathname += path.extname(requestUrl.pathname);
  }
  const allowedHost = new URL(GRAB_BASE_URL).hostname;
  if (targetUrl.hostname !== allowedHost) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Forbidden");
  }

  const { upstreamRes, body } = await fetchGrabResourceQueued(targetUrl);
  res.writeHead(upstreamRes.status, {
    "content-type": upstreamRes.headers.get("content-type") || "application/octet-stream",
    "cache-control": upstreamRes.ok ? "public, max-age=3600" : "no-store"
  });
  res.end(Buffer.from(body));
}

async function fetchGrabResourceQueued(targetUrl) {
  const run = grabResourceQueue.then(() => fetchGrabResourceWithRetry(targetUrl));
  grabResourceQueue = run.catch(() => {});
  return run;
}

async function fetchGrabResourceWithRetry(targetUrl) {
  let lastResponse = null;
  let lastBody = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await delay(350 * attempt);
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${GRAB_API_KEY}`,
        Accept: "*/*"
      }
    });
    const body = await upstreamRes.arrayBuffer();
    lastResponse = upstreamRes;
    lastBody = body;
    if (upstreamRes.ok || ![429, 502, 503, 504].includes(upstreamRes.status)) break;
  }

  return { upstreamRes: lastResponse, body: lastBody };
}

function rewriteStyleUrls(style, requestUrl) {
  const baseUrl = new URL(GRAB_BASE_URL);
  const localBase = `${requestUrl.protocol}//${requestUrl.host}`;
  const clone = structuredClone(style);
  removeInternalPoiTiles(clone);

  function rewrite(value) {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) value[key] = rewrite(child);
      return value;
    }
    if (typeof value !== "string") return value;
    if (!looksLikeGrabResource(value)) return value;

    const upstreamUrl = new URL(value, baseUrl);
    if (upstreamUrl.pathname.startsWith("/maps/tiles/")) {
      upstreamUrl.pathname = `/api${upstreamUrl.pathname}`;
    }
    const encoded = encodeURIComponent(decodeURI(upstreamUrl.href))
      .replace(/%7B/g, "{")
      .replace(/%7D/g, "}");
    return `${localBase}/api/grab-resource?url=${encoded}`;
  }

  return rewrite(clone);
}

function removeInternalPoiTiles(style) {
  delete style.sprite;

  if (style.sources?.internalpoitiles) {
    delete style.sources.internalpoitiles;
  }

  if (Array.isArray(style.layers)) {
    style.layers = style.layers.filter((layer) => {
      if (layer.source === "internalpoitiles") return false;
      if (layer["source-layer"] === "internal_poi") return false;
      return true;
    });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeGrabResource(value) {
  return value.startsWith("/")
    || value.startsWith(GRAB_BASE_URL)
    || value.includes(new URL(GRAB_BASE_URL).hostname);
}

function blankMapStyle(reason) {
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    metadata: {
      provider: "GrabMaps",
      notice: reason
    },
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#dce6e1"
        }
      }
    ]
  };
}

function osmRasterStyle(requestUrl = null) {
  return {
    version: 8,
    name: "OpenStreetMap fallback",
    glyphs: glyphsUrl(requestUrl),
    sources: {
      "osm-raster": {
        type: "raster",
        tiles: [
          "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors"
      }
    },
    layers: [
      {
        id: "osm-raster",
        type: "raster",
        source: "osm-raster",
        paint: {
          "raster-opacity": 1
        }
      }
    ]
  };
}

function glyphsUrl(requestUrl) {
  if (hasDisplayGrabKey && requestUrl) {
    const localBase = `${requestUrl.protocol}//${requestUrl.host}`;
    const upstreamUrl = new URL("/api/maps/tiles/v2/fonts/{fontstack}/{range}.pbf", GRAB_BASE_URL);
    const encoded = encodeURIComponent(decodeURI(upstreamUrl.href))
      .replace(/%7B/g, "{")
      .replace(/%7D/g, "}");
    return `${localBase}/api/grab-resource?url=${encoded}`;
  }
  return "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
}

async function callMcpTool(name, args) {
  if (!GRAB_API_KEY || !GRAB_MCP_URL) {
    throw new Error("GrabMaps MCP is not configured. Add GRABMAPS_MCP_URL and a valid MCP token to .env.local.");
  }

  const init = await mcpRequest({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "street-smart", version: "0.1.0" }
    }
  });

  const sessionId = init.sessionId;
  await mcpRequest({
    method: "notifications/initialized",
    params: {}
  }, sessionId);

  const result = await mcpRequest({
    id: 2,
    method: "tools/call",
    params: { name, arguments: args }
  }, sessionId);

  return unwrapMcpToolResult(result.body?.result);
}

async function mcpRequest(payload, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${GRAB_API_KEY}`
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(GRAB_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...payload })
  });

  const text = await response.text();
  const body = text ? parseMcpResponse(text) : null;
  if (!response.ok) {
    throw new Error(body?.error?.message || `MCP request failed: ${response.status}`);
  }

  return {
    body,
    sessionId: response.headers.get("mcp-session-id") || sessionId
  };
}

function parseMcpResponse(text) {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
  return payload ? JSON.parse(payload) : null;
}

function unwrapMcpToolResult(result) {
  if (!result) return {};
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    if (/returned status|not found|error/i.test(text)) return { error: text };
    return { text };
  }
}

function shouldUseMcp() {
  return Boolean(GRAB_MCP_URL && isMcpKey(GRAB_API_KEY));
}

function isMcpKey(key) {
  return key.startsWith("mcp_") || key.startsWith("bm_");
}

function getRouteCoordinates(requestUrl) {
  const coordinates = requestUrl.searchParams.getAll("coordinates")
    .map(parseLocation)
    .filter(Boolean);

  if (coordinates.length >= 2) return coordinates;

  return [
    parseLocation(requestUrl.searchParams.get("origin")),
    parseLocation(requestUrl.searchParams.get("destination"))
  ].filter(Boolean);
}

function parseLocation(value) {
  if (!value) return null;
  const [latitude, longitude] = value.split(",").map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function normalizeProfile(profile) {
  return new Set(["driving", "walking", "cycling", "motorcycle", "tricycle"]).has(profile)
    ? profile
    : "walking";
}

function normalizeRouteProvider(provider) {
  return provider === "osrm" ? "osrm" : "grab";
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const rootDir = cleanPath.startsWith("/src/") ? path.dirname(srcDir) : publicDir;
  const resolved = path.resolve(rootDir, `.${decodeURIComponent(cleanPath)}`);
  const allowedRoot = cleanPath.startsWith("/src/") ? srcDir : publicDir;

  if (!resolved.startsWith(allowedRoot)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

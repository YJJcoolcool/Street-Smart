# Street Smart

Street Smart is a local-first map and navigation prototype for Singapore.

The main app lets users search for places, preview and start routes, simulate navigation, detect route deviations, and submit map issue reports. Street Smart Studio gives authenticated users a workspace for reviewing and editing map reports.

## Features

- Place search with clustered map results and long-press dropped pins
- Traffic-aware route previews with alternatives, stops, and travel modes
- Navigation simulation with pause/manual controls and deviation reporting
- Configurable map providers: Grab Maps, Grab Maps Dark, Grab Maps Satellite, or OpenStreetMap
- Configurable routing providers: Grab Maps with OSRM fallback, or OSRM directly
- Local map issue reports for missing roads, wrong access, unsafe crossings, incorrect places, and navigation deviations
- Street Smart Studio for report review, missing-road drafts, missing-place placement, admin management, and local persistence
- Optional ngrok tunnel for testing from a phone

## Requirements

- Node.js 18 or newer
- A modern browser
- A GrabMaps API key for maps, search, and routing
- Optional: ngrok and an `NGROK_AUTHTOKEN` for phone testing

The browser loads MapLibre GL and Material Symbols from CDNs, so internet access is required for the default UI assets.

## Setup

1. Create `.env.local` in the project root:

   ```env
   VITE_GRABMAPS_BASE_URL=https://maps.grab.com
   VITE_GRABMAPS_API_KEY=your_grabmaps_api_key_here
   GRABMAPS_MCP_URL=https://maps.grab.com/api/v1/mcp
   NGROK_AUTHTOKEN=your_ngrok_token_here
   STUDIO_SUPERADMIN_LOGIN=admin@example.com
   STUDIO_SUPERADMIN_PASSWORD=change_this_to_a_long_password
   ```

2. Start the app:

   ```powershell
   npm start
   ```

3. Open the app:

   - Street Smart: http://localhost:5173
   - Street Smart Studio: http://localhost:5173/studio.html

## Windows Launchers

This repository includes convenience scripts for Windows:

```powershell
.\Start-StreetSmart.ps1
.\Stop-StreetSmart.ps1
```

`Start-StreetSmart.ps1` starts the Node server, opens the local app, and starts ngrok when `ngrok` and `NGROK_AUTHTOKEN` are available. The generated phone URL is written to `ngrok-url.txt`.

You can manage only the tunnel with:

```powershell
.\Start-Ngrok.ps1
.\Stop-Ngrok.ps1
```

The `.bat` files call the matching PowerShell scripts for double-click use.

## Studio Accounts

Street Smart Studio has three roles:

- `superadmin`: configured from `.env.local`; can manage admins and reports
- `admin`: created by the superadmin; can manage reports
- `user`: created through the Studio login panel; can publish map edits

Use the configured superadmin login to create and manage Studio admins.

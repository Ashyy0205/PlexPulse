# PlexPulse — Unraid Installation

## Install via Community Applications

Search for "PlexPulse" in the Community Applications plugin.
Click Install, review the settings below, then click Apply.

## Settings

**Web UI Port** — leave as 7878 unless something else is already using that port on your Unraid server.

**Data Path** — leave as the default /mnt/user/appdata/plexpulse.
This is where the database lives. Back this folder up if you want to
preserve your historical data.

**Plex Server URL** — you can leave this blank. After install, open the
PlexPulse UI and use the "Sign in with Plex" button in Settings.
If you prefer to configure it here, enter your full Plex URL including port
e.g. http://192.168.1.50:32400 — do not use localhost,
use the actual LAN IP of your Plex server.

**Collection Interval** — 6h is the recommended default.
If you want smoother charts and more granular data, set it to 1h.
There is no meaningful load impact on Plex at any of the available intervals.

**Timezone** — set this to your local timezone so chart timestamps display correctly.

## First Run

1. Click the PlexPulse icon in Unraid to open the web UI
2. Go to Settings
3. Enter your Plex server URL if you didn't set it during install
4. Click "Sign in with Plex" and complete the OAuth flow in the popup
5. Return to the dashboard — your first snapshot will collect automatically

## Accessing Plex on the Same Unraid Server

If Plex is running on the same Unraid machine, do not use localhost or 127.0.0.1
as the Plex URL. PlexPulse runs inside a Docker container with its own network
namespace. Use your Unraid server's actual LAN IP address instead, e.g.
http://192.168.1.50:32400

## Data and Backups

All data is stored in a single SQLite file at:
/mnt/user/appdata/plexpulse/plexpulse.db

Back this file up with your normal Unraid appdata backup routine
(CA Backup/Restore plugin or equivalent). The file will be a few MB
even after years of use.

## Updating

PlexPulse updates appear in the Unraid Docker update notifications
when a new image is pushed. Click Check for Updates in the Docker tab,
then update as normal. Your data volume is separate from the container
so updates never affect your stored history.

#!/usr/bin/env python3
# create-flywheel-app.py — create a GitHub App for Flywheel via the
# manifest flow.
#
# Spawns a local HTTP listener on a free port, opens GitHub's "Create
# from manifest" page in the browser, captures the redirected code,
# exchanges it for App credentials, and prints the result as JSON.
# stdout: {"id": <int>, "pem": "<PEM string>", "html_url": "<URL>"}
# stderr: progress/diagnostic messages.
#
# Usage:
#   python3 create-flywheel-app.py <owner> [--org] [--app-name NAME]
#                                   [--timeout SECONDS]
#
# Flags:
#   --org             owner is a GitHub org (default: user account)
#   --app-name NAME   App name shown in GitHub UI (default: "Flywheel")
#   --timeout N       seconds to wait for the browser callback (default 300)
#
# No external dependencies — only stdlib.
import argparse
import html
import http.server
import json
import secrets as _secrets
import socket
import sys
import urllib.parse
import urllib.request
import webbrowser

MANIFEST_URL = "https://github.com/point-source/flywheel"


def free_port() -> int:
    s = socket.socket()
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main() -> int:
    p = argparse.ArgumentParser(description="Create a GitHub App for Flywheel via the manifest flow.")
    p.add_argument("owner", help="GitHub user or org that will own the App")
    p.add_argument("--org", action="store_true", help="treat owner as an organization")
    p.add_argument("--app-name", default="Flywheel", help="App display name")
    p.add_argument("--timeout", type=int, default=300, help="seconds to wait for browser callback")
    args = p.parse_args()

    port = free_port()
    state = _secrets.token_urlsafe(16)
    redirect_url = f"http://localhost:{port}/callback"

    manifest = {
        "name": args.app_name,
        "url": MANIFEST_URL,
        "redirect_url": redirect_url,
        "public": False,
        "default_permissions": {
            "contents": "write",
            "issues": "write",
            "pull_requests": "write",
            "checks": "write",
            "metadata": "read",
        },
        "default_events": [],
    }

    # GitHub's manifest flow only reads `manifest` from a form-POST body —
    # passing it in the URL querystring renders an empty Create-App page.
    # We serve a tiny self-submitting form locally and open the browser to
    # that, so the browser POSTs the manifest to github.com for us. `state`
    # is fine in the querystring; only `manifest` requires the POST body.
    if args.org:
        gh_action = f"https://github.com/organizations/{args.owner}/settings/apps/new"
    else:
        gh_action = "https://github.com/settings/apps/new"
    start_url = f"http://localhost:{port}/start"
    manifest_json = json.dumps(manifest)
    start_html = (
        "<!DOCTYPE html><html><body onload=\"document.forms[0].submit()\" "
        "style=\"font-family:-apple-system,sans-serif;padding:2rem;max-width:600px;margin:0 auto;\">"
        "<h2>Redirecting to GitHub...</h2>"
        "<p>If your browser doesn't redirect automatically, click the button below.</p>"
        f"<form action=\"{html.escape(gh_action, quote=True)}?state={html.escape(state, quote=True)}\" method=\"post\">"
        f"<input type=\"hidden\" name=\"manifest\" value=\"{html.escape(manifest_json, quote=True)}\">"
        "<button type=\"submit\">Continue to GitHub</button>"
        "</form></body></html>"
    )

    captured: dict = {}
    # handle_request() returns either when it served a request OR when the
    # server's timeout fired with nothing to serve. BaseHTTPServer doesn't
    # surface which happened, so we count served requests and treat
    # "handle_request returned but counter didn't move" as the timeout.
    request_count = {"n": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a, **kw):
            return

        def do_GET(self):
            request_count["n"] += 1
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/start":
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(start_html.encode("utf-8"))
                return
            params = urllib.parse.parse_qs(parsed.query)
            code = params.get("code", [None])[0]
            cb_state = params.get("state", [None])[0]
            if code and cb_state == state:
                captured["code"] = code
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                body = (
                    "<!DOCTYPE html><html><body style='font-family:-apple-system,sans-serif;"
                    "padding:2rem;max-width:600px;margin:0 auto;'>"
                    "<h2 style='color:#1a7f37;'>Flywheel App created</h2>"
                    "<p>You can close this tab and return to your terminal.</p>"
                    "</body></html>"
                )
                self.wfile.write(body.encode("utf-8"))
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Bad callback (state mismatch or missing code)")

    server = http.server.HTTPServer(("localhost", port), Handler)
    server.timeout = args.timeout

    print(f"==> Opening browser to create the GitHub App.", file=sys.stderr)
    print(f"    If it doesn't open, copy this URL into your browser:", file=sys.stderr)
    print(f"    {start_url}", file=sys.stderr)
    print(f"==> Listening on {redirect_url} (timeout {args.timeout}s)", file=sys.stderr)
    try:
        webbrowser.open(start_url)
    except Exception:
        pass

    while "code" not in captured:
        before = request_count["n"]
        server.handle_request()
        if request_count["n"] == before:
            print("error: timed out waiting for browser callback", file=sys.stderr)
            return 1

    print("==> Got code from GitHub. Exchanging for App credentials...", file=sys.stderr)

    req = urllib.request.Request(
        f"https://api.github.com/app-manifests/{captured['code']}/conversions",
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "flywheel-init",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"error: GitHub rejected the manifest exchange ({e.code}): {body}", file=sys.stderr)
        return 1

    out = {"id": result["id"], "pem": result["pem"], "html_url": result["html_url"]}
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

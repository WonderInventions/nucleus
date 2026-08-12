# Uploading Releases

## Easy Way

The easiest way to upload releases to Nucleus is to use [`electron-forge`](https://github.com/electron-userland/electron-forge)
to build and publish your application.  You will find the config required
on your App's page inside Nucleus.

Check out the publisher documentation at [https://v6.electronforge.io/publishers/nucleus](https://v6.electronforge.io/publishers/nucleus)

## Custom Way

There is a upload endpoint inside Nucleus, you simply hit it with the
parameters outlined below as a POST request with a FormData body.

```
POST: /rest/app/:appId/channel/:channelId/upload
Headers:
  Authorization: <AppAuthorizationToken>
BODY:
  platform: String - One of 'darwin', 'win32' and 'linux'
  arch: String - One of 'ia32' and 'x64'
  version: String
FILES:
  <AnyString>: File
```

Please note that any files you wish to release must be attached to
the body of the request, you can use any key you want to add the
file to the body.

Any non-200 status code means something went wrong, a helpful error
message is normally included in the response.

See the [Nucleus Publisher](https://github.com/electron-userland/electron-forge/blob/master/packages/publisher/nucleus/src/PublisherNucleus.ts) for a JS code example of uploading to Nucleus.

## Releasing

Uploading puts files in a draft ("temporary release") that is not served to
users until it is released.  Each upload creates one draft per
platform/arch, so publishing a version normally means releasing several
drafts.  To release them all in one request:

```
POST: /rest/app/:appId/channel/:channelId/temporary_releases/release_all
Headers:
  Authorization: <AppAuthorizationToken>
  Content-Type: application/json
BODY:
  version: String
```

Every draft on the channel with that version is released.  Drafts for other
versions are left alone.

A `200` means all of them were released:

```json
{
  "success": true,
  "version": "1.2.3",
  "released": 3,
  "results": [
    { "saveId": 1, "platform": "darwin", "arch": "x64", "success": true, "storedFileNames": ["MyApp-1.2.3.dmg"] }
  ]
}
```

Other status codes:

* `400` — no `version` in the body
* `403` — the token or user has no permission for this app
* `404` — the channel does not exist, or no draft on it has that version
* `409` — another publish-type operation holds the channel's lock, retry later
* `500` — at least one draft failed.  The body has the same shape with
  `"success": false`, a `failed` count, and an `error` on each failed entry

### Recovering from a partial failure

A `500` means some drafts were released and some were not.  Releasing a
draft consumes it, so a draft that failed *after* its files were registered
against the version is gone and retrying `release_all` will not bring it
back.  Recovery is to upload that platform/arch again, which requires
bumping the version: the upload endpoint rejects files whose names already
exist on the version.
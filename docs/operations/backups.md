# Backups

Backups protect the WireGuard server keys, peer records, and admin state. Losing them means recreating peers by hand. Leaking them means rotating secrets. Neither is charming.

## What To Back Up

For the Compose MVP:

```text
kintunnel-data volume
kintunnel-backups volume
config/secrets
```

For Swarm:

```text
kintunnel_data volume contents
kintunnel_backups volume contents
kintunnel_config volume contents
```

Back up:

- WireGuard server config.
- Peer config records.
- Admin service state.
- Deployment `.env` stored outside public repos.

## Backup Pattern

1. Stop or pause writes to the admin UI.
2. Archive the config directory or volume.
3. Encrypt the archive.
4. Store it away from the VPS.
5. Test restore on a disposable host.

## Compose Example

```sh
docker compose stop admin engine
docker run --rm -v kintunnel-data:/data -v "$PWD:/backup" alpine tar -czf /backup/kintunnel-data-backup.tar.gz /data
docker compose start engine admin
```

Encrypt before storage:

```sh
gpg -c kintunnel-data-backup.tar.gz
```

## Restore

1. Provision a replacement VPS.
2. Install Docker and Compose.
3. Restore the config directory to the expected path.
4. Restore `.env`.
5. Start the service.
6. Confirm peers can connect.
7. Confirm client public IP is the new VPS IP, unless DNS still points to the old server.

## Diagram

See [../diagrams/backup-restore.mmd](../diagrams/backup-restore.mmd).

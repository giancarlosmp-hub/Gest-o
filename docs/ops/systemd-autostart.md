# Systemd autostart for Gest-o CRM

Install the unit file:

```bash
sudo cp docs/ops/gest-o.service /etc/systemd/system/gest-o.service
```

Enable startup:

```bash
sudo systemctl daemon-reload
sudo systemctl enable gest-o
```

Optional verification:

```bash
sudo systemctl is-enabled gest-o
```

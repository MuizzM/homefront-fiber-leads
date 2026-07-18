# Every deploy that builds an image leaks one — prune to live+rollback in the deploy script itself.
79 accumulated homefront-app images (17GB) + build cache filled the disk to 100%
("database or disk is full"), blocking deploys and endangering the SQLite volume.
deploy.sh now prunes all release tags except the live + rollback images, dangling
layers, and caps build cache at 2GB after every HEALTHY cutover. One-time recovery:
docker image prune -a -f + docker builder prune -f (never touches volumes).

#!/bin/bash

# root check

if [ "$(whoami)" != "root" ]; then
    echo "This script must be run with root privileges!"
    echo "Try sudo $0"
    exit 1
fi

usermod -a -G dialout pi

# create directories

cd /home/pi
mkdir /var/log/01v96-remote
chown pi /var/log/01v96-remote

# System update and dependency installation

apt-get update
apt-get -y upgrade
apt-get -y install git python build-essential libasound2-dev


# NodeJS setup

mkdir /opt/node
wget http://nodejs.org/dist/v0.10.24/node-v0.10.24-linux-arm-pi.tar.gz
tar xvzf node-v0.10.24-linux-arm-pi.tar.gz
cp -r node-v0.10.24-linux-arm-pi/* /opt/node
rm -f -r node-v0.10.24-linux-arm-pi
rm node-v0.10.24-linux-arm-pi.tar.gz

# Create symlinks for PATH and root access
ln -s /opt/node/bin/node /usr/bin/node
ln -s /opt/node/bin/npm /usr/bin/npm
ln -s /opt/node/lib /usr/lib/node

# Forever setup
/usr/bin/npm install -g forever

# Project setup
cd /home/pi
sudo -u pi git clone https://github.com/kryops/01v96-remote.git
cd 01v96-remote
sudo -u pi /usr/bin/npm install



cd /home/pi

echo '#!/bin/bash

### BEGIN INIT INFO
# Provides: Forever 01v96-remote
# Required-Start: $remote_fs $syslog
# Required-Stop: $remote_fs $syslog
# Default-Start: 2 3 4 5
# Default-Stop: 0 1 6
# Short-Description: Forever 01v96-remote Autostart
# Description: Forever 01v96-remote Autostart
### END INIT INFO

NAME="Forever NodeJS"
EXE=/usr/bin/forever
SCRIPT=/home/pi/01v96-remote/server.js
PARAMS=serialport
USER=pi
OUT=/var/log/01v96-remote/forever.log

if [ "$(whoami)" != "root" ]; then
    echo "This script must be run with root privileges!"
    echo "Try sudo $0"
    exit 1
fi

case "$1" in

start)
    echo "starting $NAME: $SCRIPT $PARAMS"
    sudo -u $USER $EXE start -a -l $OUT $SCRIPT $PARAMS
    ;;

stop)
    echo "stopping $NAME"
    sudo -u $USER $EXE stop $SCRIPT
    ;;

restart)
    $0 stop
    $0 start
    ;;

*)
    echo "usage: $0 (start|stop|restart)"
esac

exit 0
' > /etc/init.d/forever-01v96-remote

chmod 755 /etc/init.d/forever-01v96-remote
update-rc.d forever-01v96-remote defaults


# finished

echo "Installation complete. Please reboot your device."

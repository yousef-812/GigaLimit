const { install: installUdpSocketSafety } = require('./udp_socket_safety');
const { install: installTrafficAccounting } = require('./traffic_accounting_patch');

installUdpSocketSafety();
installTrafficAccounting();
require('./index');

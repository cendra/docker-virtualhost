const http = require('http'),
    https = require('https'),
    Docker = require('dockerode'),
    docker = new Docker({socketPath: '/var/run/docker.sock', version: process.env.DOCKER_VERSION||'v1.26'}),
    url = require('url'),
    qs = require('querystring'),
    cluster = require('cluster'),
    numCPUs = require('os').cpus().length,
    redis = require('redis'),
    fs = require('fs'),
    path = require('path'),
    net = require('net'),
    bouncy = require('bouncy'),
    Transform = require('stream').Transform,
    util = require('util'),
    base64id = require('base64id');

const redisService = process.argv[2]||process.env.REDIS||'redis';
const isProduction = !process.argv[3];
const client = redis.createClient('redis://'+redisService);
const sub = redis.createClient('redis://'+redisService);

if(cluster.isMaster) {
  var isSwarmManager = false;
  var dm = require('debug')('virtualhost:master');
  var processService = (service) => {
    var dnsName = service.Spec.Name;
    dm('Processing service '+dnsName);
    var keys = [];
    var ports = {all: 80};
    var proto = {all: 'http'};
    var doLb = !!(service.Spec.Labels.vhlb&&service.Spec.Labels.vhlb=='true');
    try { ports.all = service.Spec.Labels.vhport||80; } catch(e) {}
    try { proto.all = service.Spec.Labels.vhproto||'http'; } catch(e) {}
    var processNames = function(vhname) {
      if(!vhname) return;
      oneProcessed = true;
      if(!vhname.includes('//')) vhname='//'+vhname;
      let vurl = url.parse(vhname);
      if(/\/$/.test(vurl.pathname)) vurl.pathname = vurl.pathname.slice(0,-1);
      var key = vurl.hostname+(vurl.pathname||'');
      keys.push({key: key, path: vurl.pathname||''});
      if(vurl.port) ports[key] = vurl.port;
      if(vurl.protocol) proto[key] = vurl.protocol;
      client.sadd(dnsName, key);
      client.sadd('services', key);
    };
    try { service.Spec.Labels.vhnames.split(',').forEach(processNames); } catch(e) {}
    try { processNames(service.Spec.TaskTemplate.ContainerSpec.Hostname); } catch(e) {}
    if(!oneProcessed) {
      return dm('Could not find hostname for service '+service.Spec.Name+'. Please, try with "docker service update --label-add vhnames=<hostname1>,<hostname2>,... '+service.Spec.Name+'"');
    }
    docker.listTasks({
      filters: '{"service":["'+dnsName+'"], "desired-state":["running"]}'
    },(error, tasks)=>{
      if(error) return dm(error);
      var tasksAddresses = tasks.reduce((memo,task)=>{
        return memo.concat(task.NetworksAttachments.filter(spec=>spec.Network.Spec.Name=='virtualhost').reduce((memo,network)=>memo.concat(network.Addresses.reduce((memo,address)=>memo.concat(address.split('/')[0]),[])),[]));
      },[]);

      keys.forEach(keyObj => {
        var set = {dns: dnsName, port: ports[key]||ports.all, proto: proto[key]||proto.all, path: keyObj.path, lb: doLb};
        dm(keyObj.key+' => %j',set);
        client.hmset(keyObj.key, set);
        client.del(dnsName+':addrs',()=>{
          dm(dnsName+':addrs => %j',tasksAddresses);
          client.lpush(dnsName+':addrs',tasksAddresses);
        });

      });
    });
  };

  new Promise((resolve, reject)=>{
    dm('getting network');
    docker.getNetwork('virtualhost').inspect((err, data) => {
      if(err) return reject('Could not get virtualhost network');
      resolve(data.Id);
    });
  })
  .then((netId)=>{
    return new Promise((resolve, reject)=>{
      dm('getting services');
      docker.listServices((err, data) => {
        if(err) return reject('Could not get services');
        isSwarmManager = true;
        if(Array.isArray(data)) {
          var services = data
            .filter((service)=>!['virtualhost', redisService].includes(service.Spec.Name))
            .filter((service)=>service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId).length);
          services.forEach(processService);
        } else {
          reject('data is not an array');
        }
      });
    });
  })
  .catch((err) => {
    dm(err);
  });


  docker.getEvents({opts: {filters: qs.escape('{"type":["container"]}')}}, (err, response) => {
    dm('listening events');
    response.on('data', (data) => {
      var pdata = JSON.parse(data);
      if(['start', 'unpause'].includes(pdata.status)) {
        dm('Event detected '+pdata.status);
        client.publish('add:virtualhost:connection', data);
      }
      if(['stop','pause'].includes(pdata.status)) {
        dm('Event detected '+pdata.status);
        client.publish('rm:virtualhost:connection', data);
      }
    });
  });


  sub.subscribe('add:virtualhost:connection');
  sub.subscribe('rm:virtualhost:connection');
  sub.on('message', function(channel, data) {
    if(isSwarmManager) {
      data = JSON.parse(data);
      if(!data) return;
      if(channel == 'add:virtualhost:connection') {
        new Promise((resolve, reject)=>{
          docker.getNetwork('virtualhost').inspect((err, data) => {
            if(err) return reject('Could not get virtualhost network');
            resolve(data.Id);
          });
        })
        .then((netId)=>{
          return new Promise((resolve, reject)=>{
            var service = docker.getService(data.Actor.Attributes['com.docker.swarm.service.name']);
            service.inspect((err, service) => {
              if(err) return reject(err);
              if(!['virtualhost', redisService].includes(service.Spec.Name) && service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId).length) {
                processService(service);
              } else {
                reject('Service not suitable for virtualhost');
              }
            });
          });
        })
        .catch((error) => dm(error.message||error));
      } else {
        var name = data.Actor.Attributes['com.docker.swarm.service.name'];
        //Modificar todo lo comentado
        new Promise((resolve, reject)=>{
          docker.listTasks({filters: '{"service":["'+name+'"], "desired-state": ["running"]}'},(error, tasks)=>{
            if(error) return reject(error);
            if(Array.isArray(tasks) && tasks.length) return reject('There are still containers running for service');
            resolve();
          });
        })
        .then(()=>{
          dm('Removing service '+name);
          client.smembers(name, (error, hosts) => {
            hosts.forEach((host)=>{
              client.srem('services', host);
              client.del(host);
              client.del(host+':addrs');
            });
            client.del(name);
          });
        })
        .catch((error)=>{
          dm(error.message||error);
          docker.getTask(data.Actor.Attributes['com.docker.swarm.task.id']).inspect((error, task) => {
            if(error) return dm(error);
            var taskAdrresses = task.NetworksAttachments
                                    .filter(spec=>spec.Network.Spec.Name=='virtualhost')
                                    .reduce((memo,network)=>memo.concat(network.Addresses.reduce((memo,address)=>memo.concat(address.split('/')[0]),[])),[]);
            dm('Removing %j from '+name+':addrs',taskAdrresses);
            taskAdrresses.forEach(address=>client.lrem(name+':addrs', address));
          });
        });
      }
    } else {
      dm('am not manager!');
      sub.unsubscribe('add:virtualhost:connection');
      sub.unsubscribe('rm:virtualhost:connection');
    }
  });

  dm('forking master '+numCPUs+' times.');
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    dm(`worker ${worker.process.pid} died`);
    var hasWorkers = false;
    for(const i in cluster.workers) {
      hasWorkers=true;
      break;
    }
    if(!hasWorkers) process.exit('No more workers');
  });
} else {

  var dw = require('debug')('virtualhost:worker'),
      dt = require('debug')('virtualhost:traffic');

  var retrieveServices = function() {
    return new Promise(function(resolve, reject) {
      client.smembers('services', (error, services) => {
        if(error) return reject(error);
        svkeys=services;
        resolve(services);
      });
    });
  };
  setInterval(retrieveServices, 60 * 1000);
  retrieveServices();

  var searchSrv = function(req) {
    return new Promise(function(resolve, reject) {
      var srv = svkeys.filter(key=>new RegExp('^'+key, 'i').test(req.headers.host+req.url)).reduce((memo, key)=>{
        var ln = (req.headers.host+req.url).substr(key.length).length;
        if(!memo) return {ln: ln, key: key};
        if(ln < memo.ln) return {ln: ln, key: key};
        return memo;
      }, null);
      if(!srv) return reject();
      resolve(srv);
    });
  };

  var getService = function(req) {
    return searchSrv(req)
    .catch(retrieveServices().then(searchSrv(req)))
    .then(function(srv) {
      if(cache[srv.key]) return cache[srv.key];
      return new Promise(function(resolve, reject) {
        client.hgetall(srv.key, function(err, data) {
          if(err) return reject(err);
          cache[srv.key] = data;
          data.timeout = setTimeout(function() {
            delete cache[srv.key];
          }, 60 * 1000);
          resolve(data);
        });
      });
    });
  };

  var proxy = function(options) {
    var secure = false;
    if(options) {
      secure = options.secure;
      delete options.secure;
    }

    var getDest=function(socket, service, request) {
      var cookie = parseCookie(request.headers.cookie||'');
      var hasCookie = !!cookie;
      cookie = hasCookie?cookie[1]:base64id.generateId();
      if(!socket.dests) socket.dests = {};
      return new Promise((resolve, reject) => {
        dw('retrieving dest for ('+socket._pupi+') '+service.dns);
        if(socket.dests[service.dns]) return resolve({dest: socket.dests[service.dns]});
        if(!service.lb) {
          dw('('+socket._pupi+') Creating dest without custom load balance for '+service.dns);
          socket.dests[service.dns] = net.connect({
            port: (!isProduction&&request.headers['vh-port-override'])||service.port,
            host: service.dns
          });
          return resolve({dest: socket.dests[service.dns], new: true});
        }
        dw('('+socket._pupi+') Creating dest with custom load balance for '+service.dns);
        client.hgetall('vh:'+cookie+':cookie', function(err, params) {
          if(err) return reject(err);
          if(params) {
            dw('('+socket._pupi+') cookie '+cookie+' already registered for '+service.dns+' with params: %j',params);
            socket.dests[service.dns] = net.connect(params);
            return resolve({dest: socket.dests[service.dns], new: true});
          } else {
            client.rpoplpush(service.dns+':addrs', service.dns+':addrs', function(err, addr) {
              if(err) return reject(err);
              var params = {
                port: (!isProduction&&request.headers['vh-port-override'])||service.port,
                host: addr
              };
              dw('('+socket._pupi+') registering cookie '+cookie+' for '+service.dns+' with params: %j',params);
              socket.dests[service.dns] = net.connect(params);
              client.hmset('vh:'+cookie+':cookie', params);
              return resolve({dest: socket.dests[service.dns], new: true});
            });
          }
        });

      })
      .then((res) => {
        var dest = res.dest;
        if(res.new) {
          var vhdata = '';
          dest.on('data', (chunk) => {
            if(socket.upgraded) return;
            if(hasCookie) {
              dt('('+socket._pupi+') '+chunk.toString());
              socket.write(chunk);
            } else {
              vhdata += chunk.toString();
              if(vhdata.indexOf('\r\n\r\n') !== -1) {
                var data = vhdata.split('\r\n\r\n');
                socket.write(data[0]+'\r\nSet-Cookie: __vh='+cookie+'; Path=/; HttpOnly\r\n\r\n'+(data[1]||''));
                dt('('+socket._pupi+') '+data[0]+'\r\nSet-Cookie: __vh='+cookie+'; HttpOnly\r\n\r\n'+(data[1]||''));
                hasCookie = true;
                vhdata = '';
              }
            }
          });

          dest.on('close', () => {
            if(socket.dests[service.dns]) dest.destroy();
            delete socket.dests[service.dns];
          });
          dest.on('error', () => {
            if(socket.dests[service.dns]) dest.destroy();
            delete socket.dests[service.dns];
          });
        }
        return dest;
      });
    };

    var server = secure?https.createServer(options):http.createServer();

    var parseCookie = function(cookie) {
      return cookie.split(';').map(cookie=>cookie.trim().split('=')).filter(cookie=>cookie[0]=='__vh')[0];
    };

    server.on('request', function(request, response) {
      //_pupi is just an identifier for debugging purposes
      if(!request.connection._pupi) request.connection._pupi = Math.random();
      dw('('+request.connection._pupi+') request '+request.url);
      getService(request)
      .then((service)=>{
        return getDest(request.connection, service, request)
        .then((dest) => {
          var payload = Object.keys(request.headers).reduce(function (head, key) {
            var value = request.headers[key];

            if(key.toLowerCase()=='host') {
              head.push('Host: '+service.dns);
              return head;
            }

            if (!Array.isArray(value)) {
              head.push(key + ': ' + value);
              return head;
            }

            for (var i = 0; i < value.length; i++) {
              head.push(key + ': ' + value[i]);
            }
            return head;
          }, [request.method+' '+request.url.substr(service.path.length)+' HTTP/'+request.httpVersion, 'X-Forwarded-Host: '+request.headers.host, 'X-Forwarded-Proto: '+service.proto, 'X-Forwarded-Prefix: '+service.path])
          .join('\r\n') + '\r\n\r\n';
          dest.write(payload);

          request.on('data', function(chunk) {
            dest.write(chunk);
          });
        });
      });
    });
    server.on('upgrade', function(request, socket, head){
      if(!socket._pupi) socket._pupi = Math.random();
      dw('('+socket._pupi+') upgraded '+request.url);
      socket.upgraded = true;
      getService(request)
      .then((service)=>{
        return getDest(socket, service, request)
        .then((dest) => {
          var payload = Object.keys(request.headers).reduce(function (head, key) {
            var value = request.headers[key];

            if(key.toLowerCase()=='host') {
              head.push('Host: '+service.dns);
              return head;
            }

            if (!Array.isArray(value)) {
              head.push(key + ': ' + value);
              return head;
            }

            for (var i = 0; i < value.length; i++) {
              head.push(key + ': ' + value[i]);
            }
            return head;
          }, [request.method+' '+request.url.substr(service.path.length)+' HTTP/'+request.httpVersion, 'X-Forwarded-Host: '+request.headers.host, 'X-Forwarded-Proto: '+service.proto, 'X-Forwarded-Prefix: '+service.path])
          .join('\r\n') + '\r\n\r\n';
          dest.write(payload);
          socket.pipe(dest).pipe(socket);
        });
      });
    });
    return server;
  };

  dw('Child process '+process.pid);
  var cache = {};
  var svkeys = [];

  var insecure = proxy();
  insecure.listen(80);

  var mkSecure = true;
  try {
    var key = fs.readFileSync(path.join('run', 'secrets', 'key'));
    var cert = fs.readFileSync(path.join('run', 'secrets', 'cert'));
  } catch(e) {
    mkSecure = false;
  }
  if(mkSecure) {
    dw('Creating secure server');
    var secure = proxy({
      key: key,
      cert: cert,
      secure: true,
      SNICallback: (vhname, cb)=>{
        try {
          var _key = fs.readFileSync(path.join('run', 'secrets', vhname+'_key'));
          var _cert = fs.readFileSync(path.join('run', 'secrets', vhname+'_cert'));
          cb(null, tsl.createSecureContext({key: _key, cert: _cert}));
        } catch(e) {
          cb(null, tsl.createSecureContext({key: key, cert: cert}));
        }
      }
    });
    secure.listen(443);
  }
}

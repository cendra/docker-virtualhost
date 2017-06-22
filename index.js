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
    path = require('path');
    net = require('net');
    const Transform = require('stream').Transform;

const redisService = process.argv[2]||process.env.REDIS||'redis';
const isProduction = !process.argv[3];
const client = redis.createClient('redis://'+redisService);
const sub = redis.createClient('redis://'+redisService);

if(cluster.isMaster) {
  var isSwarmManager = false;
  var processService = (service) => {
    var dnsName = service.Spec.Name;
    var keys = [];
    var ports = {all: 80};
    var proto = {all: 'http'};
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
      console.log('Could not find hostname for service '+service.Spec.Name+'. Please, try with "docker service update --label-add vhnames=<hostname1>,<hostname2>,... '+service.Spec.Name+'"');
    }
    keys.forEach(keyObj => {
      client.hmset(keyObj.key, {dns: dnsName, port: ports[key]||ports.all, proto: proto[key]||proto.all, path: keyObj.path});
    });
  };

  new Promise((resolve, reject)=>{
    console.log('getting network');
    docker.getNetwork('virtualhost').inspect((err, data) => {
      if(err) return reject('Could not get virtualhost network');
      resolve(data.Id);
    });
  })
  .then((netId)=>{
    return new Promise((resolve, reject)=>{
      console.log('getting services');
      docker.listServices((err, data) => {
        if(err) return reject('Could not get services');
        isSwarmManager = true;
        if(Array.isArray(data)) {
          var services = data
            .filter((service)=>!['virtualhost', redisService].includes(service.Spec.Name))
            .filter((service)=>service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId).length);
          services.forEach(processService);
        } else {
          console.log(data);
        }
      });
    });
  })
  .catch((err) => {
    console.log(err);
  });


  docker.getEvents({opts: {filters: qs.escape('{"type":["container"]}')}}, (err, response) => {
    console.log('listening events');
    response.on('data', (data) => {
      console.log('data '+data);
      var pdata = JSON.parse(data);
      if(['start', 'unpause'].includes(pdata.status)) {
        client.publish('add:virtualhost:connection', data);
      }
      if(['stop','pause'].includes(pdata.status)) {
        client.publish('rm:virtualhost:connection', data);
      }
    });
  });


  sub.subscribe('add:virtualhost:connection');
  sub.subscribe('rm:virtualhost:connection');
  sub.on('message', function(channel, data) {
    console.log('received start event %j', arguments);
    if(isSwarmManager) {
      data = JSON.parse(data);
      console.log('am manager!');
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
                console.log('Service not suitable for virtualhost');
              }
            });
          });
        });
      } else {
        var name = data.Actor.Attributes['com.docker.swarm.service.name'];
        //Modificar todo lo comentado
        new Promise((resolve, reject)=>{
          docker.listTasks({opts: {
            filters: qs.escape('{"service":['+name+'], "desired-state": ["running"]}')
          }},(error, tasks)=>{
            if(error) return reject(error);
            if(Array.isArray(tasks) && tasks.length) return reject('There are still containers running for service');
            resolve();
          })
          .then(()=>{
            client.smembers(name, (error, hosts) => {
              hosts.forEach((host)=>{
                client.srem('services', host);
                client.del(host);
              });
              client.del(name);
            });
          });
        });
      }
    } else {
      console.log('am not manager!');
      sub.unsubscribe('add:virtualhost:connection');
      sub.unsubscribe('rm:virtualhost:connection');
    }
  });

  console.log('forking master');
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
    var hasWorkers = false;
    for(const i in cluster.workers) {
      hasWorkers=true;
      break;
    }
    if(!hasWorkers) process.exit('No more workers');
  });
} else {

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

  var proxyWS = function(req, extSocket, head) {
    getService(req)
    .then(function(service) {
      var ops = {
        hostname: service.dns,
        port: (!isProduction&&req.headers['vh-port-override'])||service.port,
        method: req.method,
        path: req.url.substr(service.path.length),
        headers: req.headers
      };
      http.request(ops)
        .on('upgrade', function(res, proxySocket, head) {
          console.log('got upgrade response');
          extSocket.on('error', function() {
            proxySocket.end();
          });
          extSocket.write(
            Object.keys(res.headers).reduce(function (head, key) {
              var value = res.headers[key];

              if (!Array.isArray(value)) {
                head.push(key + ': ' + value);
                return head;
              }

              for (var i = 0; i < value.length; i++) {
                head.push(key + ': ' + value[i]);
              }
              return head;
            }, ['HTTP/1.1 101 Switching Protocols', 'X-Forwarded-Host: '+req.headers.host, 'X-Forwarded-Proto: '+service.proto, 'X-Forwarded-Prefix: '+service.path])
            .join('\r\n') + '\r\n\r\n'
          );
          proxySocket.pipe(extSocket).pipe(proxySocket);
        })
        .on('error', function(error) {
          console.log(error);
          extSocket.end();
        })
        .end();
    });
  };

  var proxyHTTP = function(secure) {
      return function(req, res) {
        console.log(req.method+' '+req.headers.host+req.url);
        getService(req)
        .then(function(service) {
          if(service.proto != 'http'+(secure?'s':'')) {
            res.statusCode = 301;
            res.setHeader('Location', 'http'+(secure?'':'s')+'://'+req.headers.host+req.url);
            return res.end();
          }
          req.headers['x-forwarded-host'] = req.headers.host;
          req.headers['x-forwarded-proto'] = service.proto;
          req.headers['x-forwarded-prefix'] = service.path;
          req.pipe(http.request({
            hostname: service.dns,
            port: (!isProduction&&req.headers['vh-port-override'])||service.port,
            method: req.method,
            path: req.url.substr(service.path.length),
            headers: req.headers
          }, function(response) {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          })).on('error', (error) => {
            console.log(error);
          });
        })
        .catch(function(error) {
          console.log(error);
          res.statusCode = 404;
          return res.end('Page not found');
        });
      };
  };

  console.log('Child process '+process.pid);
  var cache = {};
  var svkeys = [];

  var insecure = http.createServer(proxyHTTP());
  insecure.on('upgrade', proxyWS);
  insecure.listen(80);

  var mkSecure = true;
  try {
    var key = fs.readFileSync(path.join('run', 'secrets', 'key'));
    var cert = fs.readFileSync(path.join('run', 'secrets', 'cert'));
  } catch(e) {
    mkSecure = false;
  }
  if(mkSecure) {
    var secure = https.createServer({
      key: key,
      cert: cert,
      SNICallback: (vhname, cb)=>{
        try {
          var _key = fs.readFileSync(path.join('run', 'secrets', vhname+'_key'));
          var _cert = fs.readFileSync(path.join('run', 'secrets', vhname+'_cert'));
          cb(null, tsl.createSecureContext({key: _key, cert: _cert}));
        } catch(e) {
          cb(null, tsl.createSecureContext({key: key, cert: cert}));
        }
      }
    }, proxyHTTP(true));
    secure.on('upgrade', proxyWS);
    secure.listen(443);
  }
}

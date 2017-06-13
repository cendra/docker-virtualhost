const http = require('http'),
    https = require('https'),
    tls = require('tls'),
    proxy = require('http-proxy').createProxyServer({}),
    Docker = require('dockerode'),
    docker = new Docker({socketPath: '/var/run/docker.sock', version: process.env.DOCKER_VERSION||'v1.26'}),
    url = require('url'),
    qs = require('querystring'),
    cluster = require('cluster'),
    numCPUs = require('os').cpus().length,
    redis = require('redis'),
    fs = require('fs'),
    path = require('path');

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
    try { ports.all = service.Spec.Labels.vhport||80; } catch(e) {};
    try { proto.all = service.Spec.Labels.vhproto||'http'; } catch(e) {};
    var processNames = function(vhname) {
      if(!vhname) return;
      console.log('Processing dns '+vhname);
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
    try { service.Spec.Labels.vhnames.split(',').forEach(processNames); } catch(e) {};
    try { processNames(service.Spec.TaskTemplate.ContainerSpec.Hostname); } catch(e) {};
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
        if(err) {
		return reject('Could not get services');
        }
		isSwarmManager = true;
	if(Array.isArray(data)) {
          var services = data
            .filter((service)=>!['virtualhost', redisService].includes(service.Spec.Name))
            .filter((service)=>service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId).length);
          services.forEach(processService);
        } else {
          console.log(data);
        }
      })
    });
  })
  .catch((err) => {
    console.log(err);
  });


  docker.getEvents({opts: {filters: qs.escape('{"type":["container"]}')}}, (err, response) => {
    console.log('listening events');
    response.on('data', (data) => {
      parsed = JSON.parse(data);
      if(['start', 'unpause'].includes(parsed.status)) {
        client.publish('add:virtualhost:connection', data);
      }
      if(['stop','pause'].includes(parsed.status)) {
        client.publish('rm:virtualhost:connection', data);
      }
    });
  });

/*  request.get("/events?filters={event:['destroy','die','stop','pause'],type:['container']}", (err, response, body) => {
      if(err) console.log(err);
      console.log('listening stop container');
      response.on('data', (data) => {
        console.log('start data arrived '+data);
        client.publish('rm:virtualhost:connection', data);
      });
  });*/

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
  });
} else {
  console.log('Child process '+process.pid);
  var cache = {};
  var fillCache = ()=> {
    return new Promise((resolve, reject)=>{
      client.smembers('services', (error, services) => {
        if(error) return reject(error);
        resolve(services);
      });
    })
    .then((services) => {
      return Promise.all(services.map(service=>{
        return new Promise((resolve, reject) => {
          client.hgetall(service, function(err, data) {
            if(err) return reject(err);
            resolve({key: service, data: data});
          });
        });
      }));
    })
    .then((services)=>{
      var tmpCache = {};
      services.forEach(service=>tmpCache[service.key]=service.data);
      cache = tmpCache;
    });
  };

  setInterval(fillCache, 60 * 1000);

  var getService = function(req) {
    //console.log('getService');

    var getCatched = () => {
      //console.log('getCatched');
      return new Promise((resolve, reject) => {
        var srv = Object
          .keys(cache)
          .filter(key=>new RegExp('^'+key, 'i').test(req.headers.host+req.url))
          .reduce((memo, key)=>{
          var ln = (req.headers.host+req.url).substr(key.length).length;
          if(!memo) return {ln: ln, key: key};
          if(ln < memo.ln) return {ln: ln, key: key};
          return memo;
        }, null);

        if(srv) {
          //console.log('catched');
          return resolve(cache[srv.key]);
        }

        reject();
      });
    };

    return getCatched()
    .catch(fillCache)
    .then(getCatched);
  };

  var insecure = http.createServer(function(req, res) {
    console.log(req.method+' '+req.headers.host+req.url);
    getService(req)
    .then((service) => {
      //console.log('proxy');
      if(service.proto == 'https') {
        res.statusCode = 301;
        res.setHeader('Location', 'https://'+req.headers.host+req.url);
        return res.end();
      }
      req.url = req.url.substr(service.path.length);
      var port = (!isProduction&&req.headers['vh-port-override'])||service.port;
      //console.log(service.dns+req.url);
      proxy.web(req, res, {
        target: 'http://'+service.dns+':'+port
      }, function(err) {
        if(err) console.log(err);
      });
    })
    .catch((error)=>{
      console.log(error);
      res.statusCode = error.statusCode;
      res.end(error.msg);
    });
  });
  insecure.on('upgrade', function (req, socket, head) {
    getService(req)
    .then((service) => {
      req.url = req.url.substr(service.path.length);
      var port = (!isProduction&&req.headers['vh-port-override'])||service.port;
      proxy.ws(req, socket, head, {
        target: 'http://'+service.dns+':'+port
      });
    });
  });
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
      SNICallback: (vhname, cb)=>{
        try {
          var key = fs.readFileSync(path.join('run', 'secrets', vhname+'_key'));
          var cert = fs.readFileSync(path.join('run', 'secrets', vhname+'_cert'));
          cb(null, tls.createSecureContext({key: key, cert: cert}));
        } catch(e) {
          cb('Could not obtain cert files');
        }
      },
      key: key,
      cert: cert
    }, (req, res) => {
      console.log(req.method+' '+req.headers.host+req.url);
      getService(req)
      .then((service) => {
        if(service.proto == 'http') {
          res.statusCode = 301;
          res.setHeader('Location', 'http://'+req.headers.host+req.url);
          return res.end();
        }
        req.url = req.url.substr(service.path.length);
        var port = (!isProduction&&req.headers['vh-port-override'])||service.port;
        //console.log(service.dns+req.url);
        proxy.web(req, res, {
          target: 'http://'+service.dns+':'+port
        }, function(err) {
          if(err) console.log(err);
        });
      })
      .catch((error)=>{
        console.log(error);
        res.statusCode = error.statusCode;
        res.end(error.msg);
      });
    });
    secure.on('upgrade', function (req, socket, head) {
      getService(req)
      .then((service) => {
        req.url = req.url.substr(service.path.length);
        proxy.ws(req, socket, head, {
          target: {
            host: service.dns,
            port: (!isProduction&&req.headers['vh-port-override'])||service.port
          }
        });
      });
    });
    secure.listen(443);
  }
}

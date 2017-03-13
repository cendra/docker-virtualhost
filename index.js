const http = require('http'),
    bouncy = require('bouncy'),
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
      })
    });
  })
  .catch((err) => {
    console.log(err);
  });


  docker.getEvents({opts: {filters: qs.escape('{"type":["container"]}')}}, (err, response) => {
    console.log('listening events');
    response.on('data', (data) => {
      console.log('data '+data);
      data = JSON.parse(data);
      if(['start', 'unpause'].includes(data.status)) {
        console.log(data);
        client.publish('add:virtualhost:connection', data);
      }
      if(['destroy','die','stop','pause'].includes(data.status)) {
        console.log(data);
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

  sub.subscribe('add:virtualhost:connection', function(data) {
    if(isSwarmManager) {
      console.log('received start event');
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
      sub.unsubscribe('add:virtualhost:connection');
      sub.unsubscribe('rm:virtualhost:connection');
    }
  });

  sub.subscribe('rm:virtualhost:connection', function(data) {
    if(isSwarmManager) {
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
    } else {
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

  var insecure = bouncy((req, res, bounce) => {
    console.log(req.method+' '+req.headers.host+req.url);
    var doBounce=function(service) {
      if(service.proto == 'https') {
        res.statusCode = 301;
        res.setHeader('Location', 'https://'+req.headers.host+req.url);
        return res.end();
      }
      bounce(service.dns, (!isProduction&&req.headers['vh-port-override'])||service.port, {
        path: req.url.substr(service.path.length)
      });
    };
    var srv = Object.keys(cache).filter(key=>new RegExp('^'+key, 'i').test(req.headers.host+req.url)).reduce((memo, key)=>{
      var ln = (req.headers.host+req.url).substr(key.length).length;
      if(!memo) return {ln: ln, key: key};
      if(ln < memo.ln) return {ln: ln, key: key};
      return memo;
    }, null);
    if(srv) {
      if(cache[srv.key].timeout) clearTimeout(cache[srv.key].timeout);
      cache[srv.key].timeout = setTimeout(function() {
        delete cache[srv.key];
      }, 60 * 1000);
      return doBounce(cache[srv.key]);
    }
    client.smembers('services', (error, services) => {
      var srv = services.filter(key=>new RegExp('^'+key, 'i').test(req.headers.host+req.url)).reduce((memo, key)=>{
        var ln = (req.headers.host+req.url).substr(key.length).length;
        if(!memo) return {ln: ln, key: key};
        if(ln < memo.ln) return {ln: ln, key: key};
        return memo;
      }, null);
      if(!srv) {
        res.statusCode = 404;
        return res.end('Page not found');
      }
      new Promise((resolve, reject) => {
        client.hgetall(srv.key, function(err, data) {
          if(err) return reject(err);
          resolve(data);
        });
      })
      .then(data => {
        data.timeout = setTimeout(function() {
          delete cache[srv.key];
        }, 60 * 1000);
        cache[srv.key] = data;
        doBounce(cache[srv.key]);
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
    var secure = bouncy({
      SNICallback: (vhname, cb)=>{
        try {
          var key = fs.readFileSync(path.join('run', 'secrets', vhname+'_key'));
          var cert = fs.readFileSync(path.join('run', 'secrets', vhname+'_cert'));
          cb(null, tsl.createSecureContext({key: key, cert: cert}));
        } catch(e) {
          cb('Could not obtain cert files');
        }
      }
    }, (req, res, bounce) => {
      var doBounce=function(service) {
        if(service.proto != 'https') {
          res.statusCode = 301;
          res.setHeader('Location', 'http://'+req.headers.host+req.url);
          return res.end();
        }
        bounce(service.dns, (!isProduction&&req.headers['vh-port-override'])||service.port, {
          path: req.url.substr(service.path.length)
        });
      };
      var srv = Object.keys(cache).filter(key=>new RegExp('^'+key, 'i').test(req.headers.host+req.url)).reduce((memo, key)=>{
        var ln = (req.headers.host+req.url).substr(key.length).length;
        if(!memo) return {ln: ln, key: key};
        if(ln < memo.ln) return {ln: ln, key: key};
        return memo;
      }, null);
      if(srv) {
        if(cache[srv.key].timeout) clearTimeout(cache[srv.key].timeout);
        cache[srv.key].timeout = setTimeout(function() {
          delete cache[srv.key];
        }, 60 * 1000);
        return doBounce(cache[srv.key]);
      }
      client.smembers('services', (error, services) => {
        var srv = services.filter(key=>new RegExp('^'+key, 'i').test(req.headers.host+req.url)).reduce((memo, key)=>{
          var ln = (req.headers.host+req.url).substr(key.length).length;
          if(!memo) return {ln: ln, key: key};
          if(ln < memo.ln) return {ln: ln, key: key};
          return memo;
        }, null);
        if(!srv) {
          res.statusCode = 404;
          return res.end('Page not found');
        }
        new Promise((resolve, reject) => {
          client.hgetall(srv.key, function(err, data) {
            if(err) return reject(err);
            resolve(data);
          });
        })
        .then(data => {
          data.timeout = setTimeout(function() {
            delete cache[srv.key];
          }, 60 * 1000);
          cache[srv.key] = data;
          doBounce(cache[srv.key]);
        });
      });
    });
    secure.listen(443);
  }
}

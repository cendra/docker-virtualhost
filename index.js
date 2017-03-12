const http = require('http'),
    //httpProxy = require('http-proxy'),
    bouncy = require('bouncy'),
    /*express=require('express'),
    app = express(),*/
    request = require('request').defaults({json: true, baseUrl:'http://unix:/var/run/docker.sock:'}),
    url = require('url'),
    //bodyParser = require('body-parser'),
    //config = require('./config'),
    //async = require('async'),
    //extend = require('extend'),
    cluster = require('cluster'),
    numCPUs = require('os').cpus().length,
    redis = require('redis'),
    fs = require('fs'),
    path = require('path');

const redisService = process.argv[2];
const isProduction = !process.argv[3];
const client = redis.createClient(redisService||'redis');
const sub = redis.createClient(redisService||'redis');

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
    request.get('/networks/virtualhost', (error, response, headers) => {
      if(headers.statusCode >= 400) return reject('Could not get virtualhost network');
      resolve(response.body.Id);
    });
  })
  .then((netId)=>{
    return new Promise((resolve, reject)=>{
      request.get('/services', (error, response, headers) => {
        if(headers.statusCode >= 400) return reject('Could not get services');
        isSwarmManager = true;
        var services = response.body
          .filter((service)=>!['virtualhost', redisService||'redis'].includes(service.Spec.Name))
          .filter((service)=>service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId).length);
        services.forEach(processService);
      });
    });
  })
  .catch((err) => {
    console.log(err);
  });

  request.get(
    url.format({
      pathname: '/events',
      query: {
        filters: {
          event: ['start', 'unpause'],
          type: ['container']
        }
      }
    }), (err, response, headers) => {
    response.on('data', (data) => {
      client.publish('add:virtualhost:connection', data);
    });
  });

  request.get(
    url.format({
      pathname: '/events',
      query: {
        filters: {
          event: ['destroy', 'die', 'stop', 'pause'],
          type: ['container']
        }
      }
    }), (err, response, headers) => {
    response.on('data', (data) => {
      client.publish('rm:virtualhost:connection', data);
    });
  });

  sub.subscribe('add:virtualhost:connection', function(data) {
    if(isSwarmManager) {
      new Promise((resolve, reject)=>{
        request.get('/networks/virtualhost', (error, response, headers) => {
          if(headers.statusCode >= 400) return reject('Could not get virtualhost network');
          resolve(response.body.Id);
        });
      })
      .then((netId)=>{
        return new Promise((resolve, reject)=>{
          request.get('/services/'+data.Actor.Attributes['com.docker.swarm.service.name'], (error, response, headers)=>{
            if(headers.statusCode >= 400) return reject(error);
            var service = response.body;
            if(!['virtualhost', redisService||'redis'].includes(service.Spec.Name) && service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId).length) {
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
        request.get(url.format({
          pathname: '/tasks',
          query: {
            filters: {
              service: [name],
              'desired-state': ['running']
            }
          }
        }),(error, response, headers)=>{
          if(response.body.length) return reject('There are still containers running for service');
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

  var cache = {};

  var insecure = bouncy((req, res, bounce) => {
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
        });
      });
    });
    secure.listen(443);
  }
}

const http = require('http'),
    httpProxy = require('http-proxy'),
    /*express=require('express'),
    app = express(),*/
    request = require('request').defaults({json: true, baseUrl:'http://unix:/var/run/docker.sock:'}),
    url = require('url'),
    //bodyParser = require('body-parser'),
    //config = require('./config'),
    async = require('async'),
    extend = require('extend'),
    cluster = require('cluster'),
    numCPUs = require('os').cpus().length,
    redis = require("redis");

const redisService = process.argv[2];


function getRedis() {
  return new Promise((resolve, reject) => {
    request.get('/networks?name=vh-backend', function(error, response, headers) {
      if(headers.statusCode >= 400) return reject('Could not get vh-backend network');
      var netId = response.body.Id;
      request.get('/services?name='+(redisService||'redis'), function(error, response, headers) {
        if(headers.statusCode >= 400) return reject('Could not get redis service');
        var redisIp = response.body[0].Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID == netId)[0].Addr;
        var client = redis.createClient(redisIp);
        var sub = redis.createClient(redisIp);
        resolve({client: client, sub: sub});
      });
    });
  });
}

if(cluster.isMaster) {
  var isSwarmManager = false;

  var processService = (service) => {
    var serviceIp = service.Endpoint.VirtualIPs.filter((vip)=>vip.NetworkID==netId)[0].Addr.split('/')[0];
    var keys = [];
    var ports = {all: 80};
    var proto = {all: 'http'};
    try { ports.all = service.Spec.Labels.vhport||80; } catch(e) {};
    try { ports.all = service.Spec.Labels.vhproto||'http'; } catch(e) {};
    var processNames = function(vhname) {
      if(!vhname) return;
      oneProcessed = true;
      if(!vhname.includes('//')) vhname='//'+vhname;
      let vurl = url.parse(vhname);
      var key = vurl.hostname+(vurl.pathname||'');
      if(/\/$/.test(key)) key = key.slice(0,-1);
      keys.push(key);
      if(vurl.port) ports[key] = vurl.port;
      if(vurl.protocol) proto[key] = vurl.protocol;
      redis.client.sadd(services, key);
    }
    try { service.Spec.Labels.vhnames.split(',').forEach(processNames); } catch(e) {};
    try { processNames(service.Spec.TaskTemplate.ContainerSpec.Hostname); } catch(e) {};
    if(!oneProcessed) {
      console.log('Could not find hostname for service '+service.Spec.Name+'. Please, try with "docker service update --label-add vhnames=<hostname1>,<hostname2>,... '+service.Spec.Name+'"');
    }
    keys.forEach(key => {
      redis.client.set(key+':ip', serviceIp);
      redis.client.set(key+':port', ports[key]||ports.all);
      redis.client.set(key+':proto', proto[key]||proto.all);
    });
  };

  getRedis()
  .then((redis) => {
    new Promise((resolve, reject)=>{
      request.get('/networks?name=virtualhost', (error, response, headers) => {
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
          services.forEach();
        });
      });
    })
    .catch((err) => {
      console.log(err);
    });

    request.get('/events?event=connect&type=network&network=virtualhost', (err, response, headers) {
      response.on('data', (data) => {
        if(isSwarmManager) {
          
        } else {
          redis.client.publish('new:virtualhost:connection', data);
        }
      })
    });

  });

  console.log('forking master');
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
  });
} else {
  var proxy = httpProxy.createProxyServer({});
  var services = {};
  var hosts = {};

  var logger = function(req, res, next){
    var config = require('./config');
    req.logger = {
      log: function() {
        if(config.log) {
            arguments[0] = req.headers.host+' '+req.method+' '+req.url+'::'+arguments[0];
            console.log.apply(console, arguments);
        }
      }
    }
    next && next();
  };

  var processService = function(service) {
    var name = service.Name.substr(0, 1) == '/'?service.Name.substr(1):service.Name;
    services[name] = services[name]||{};
    if(!services[name].ip) services[name].ip = service.NetworkSettings.IPAddress;
    if(!services[name].hostname) services[name].hostname = [name+'.'+config.defaultDomain];
    services[name].hostname.forEach(function(host) {
      hosts[host] = services[name];
    });
    if(!services[name].port) {
      var ports = [];
      for(var i in service.Config.ExposedPorts) {
        if(!service.NetworkSettings.Ports[i] && i.substr(-4) == '/tcp') {
          var port = parseInt(i.substr(0, i.length-4), 10);
          if(!ports.length) {
            ports.push(port);
            continue;
          }
          if(ports[0] > port) {
            ports.unshift(port);
          } else {
            ports.push(port);
          }
        }
      }
      if(ports.length) {
        if (ports.indexOf(80)!==-1) {
          services[name].port = 80;
        } else if (ports.indexOf(443)!==-1) {
          services[name].port = 443;
        } else if (ports.indexOf(8080)!==-1) {
          services[name].port = 8080;
        } else if (ports.indexOf(8443)!==-1) {
          services[name].port = 8443;
        } else {
          services[name].port = ports[0];
        }
      }
    }
  }

  var fillServices = function() {
    //docker ps --format "{{.Names}}" -f "name=ci-jenk"|grep -w ci-jenk|wc -l
      var ops = {
        uri: config.docker+'/containers/json',
        headers: {
          host: 'localhost:80'
        }
      };
      request(ops, function(error, response, body) {
        services = extend(true, {}, config.services||{});
        var hosts = {};
        if(!error && response.statusCode == 200) {
          try {
            body = JSON.parse(body);
            async.each(body, function(service, cb) {
              var ops = {
                uri: config.docker+'/containers/'+service.Id+'/json',
                headers: {
                  host: 'localhost:80'
                }
              };
              request(ops, function(error, response, body) {
                try {
                  body = JSON.parse(body);
                  processService(body);
                } catch(e) {
                  console.log(e);
                }
                cb();
              });
            });
          } catch(e) {
            console.log(e);
          }
        } else {
          console.log(error||body);
        }
      });
  }

  fillServices();
  setInterval(fillServices, 10000);

  //app.use(bodyParser.raw({limit: '50mb', type: '*/*'}));
  //app.use(logger);


  /*app.use(function(req, res, next) {
    if(req.body) {
      req.logger.log('Body: %o',req.body);
    } else {
      req.logger.log('');
    }
    next();
  });*/

  var pickServer = function(req, cb) {
    async.auto({
      srv: function (cb) {
        var match;
        explicitPort = false;
        if(!(match = req.headers.host.match(/^([^.]+)(.*)$/))) return res.status(404).send("Page Not Found");
        var portMatch;
        if(portMatch = match[1].match(/^(\w+)__(\d+)__$/)) {
          explicitPort = portMatch[2];
          match[1] = portMatch[1];
        }
        cb(null, {name: match[1], domain: match[2], explicitPort: explicitPort});
      },
      search: ['srv', function(auto, cb) {
        if(!hosts[auto.srv.name+auto.srv.domain]) {
          if(auto.srv.domain == '.'+config.defaultDomain) {
            return request(config.docker+'/containers/'+auto.srv.name+'/json', function(error, response, body) {
              if(!error && response.statusCode == 200) {
                try {
                  body = JSON.parse(body);
                  if(body.State.Running) {
                    processService(body);
                    return cb(null, hosts[auto.srv.name+auto.srv.domain]);
                  } else {
                    return cb({status: 503, msg: "Service Unavailable"});
                  }
                } catch(e) {
                  req.logger.log(e);
                }
              }
              cb({status: 404, msg: "Page Not Found"});
            });
          }
          return cb({status: 404, msg: "Page Not Found"});
        }
        cb(null, hosts[auto.srv.name+auto.srv.domain])
      }]
    }, function(err, auto) {
      if(!err && !auto.search) {
        req.logger.log("No se pudo encontrar el servicio "+auto.srv.name+auto.srv.domain);
        err = {status: 500, msg: "Internal Server Error"};
      }

      cb(err, !err && {target: 'http://'+auto.search.ip+':'+(auto.srv.explicitPort||auto.search.port)});
    });
  }


  var app = http.createServer(function(req, res) {
    logger(req, res);
    //req.logger.log("recibiendo pedido");
    if(config.debug) {
      req.logger.log('%j', req.headers);
    }
    pickServer(req, function(err, options) {
      if(err) {
        res.statusCode = err.status||500;
        res.statusMessage = err.msg||err;
        return res.end();
      }
      proxy.web(req, res, options);
    });
  });

  app.on('upgrade', function(req, socket, head) {
    logger(req);
    req.logger.log("mejorando la conexion");
    pickServer(req, function(err, options) {
      if(err) {
          req.logger.log('%j', err);
          return socket.destroy();
      }
      proxy.ws(req, socket, head, options);
    });
  });

  proxy.on('error', function(err, req, res) {
    req.logger.log(err);
  })

  app.listen(80);
}

var express=require('express'),
    exec = require('child_process').exec,
    app = express(),
    request = require('request'),
    url = require('url'),
    fs = require('fs'),
    bodyParser = require('body-parser'),
    config = require('./config'),
    async = require('async'),
    extend = require('extend');

var logger = function(req, res, next){
  config = require('./config');
  req.logger = {
    log: function() {
      if(config.log) {
          arguments[0] = req.headers.host+' '+req.method+' '+req.url+'::'+arguments[0];
          console.log.apply(console, arguments);
      }
    }
  }
  next();
};
var services = {};
var hosts = {};
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
    request(config.docker+'/containers/json', function(error, response, body) {
      services = extend(true, {}, config.services||{});
      var hosts = {};
      if(!error && response.statusCode == 200) {
        try {
          body = JSON.parse(body);
          async.each(body, function(service, cb) {
            request(config.docker+'/containers/'+service.Id+'/json', function(error, response, body) {
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

app.use(bodyParser.raw({limit: '50mb', type: '*/*'}));
app.use(logger);
/*app.use(bodyParser.json({limit: '50mb'}));
app.use(bodyParser.urlencoded({limit: '50mb'}));*/


app.use(function(req, res, next) {
  if(req.body) {
    req.logger.log('Body: %o',req.body);
  } else {
    req.logger.log('');
  }
  next();
});

app.use(function(req, res, next) {
  //var hostname = url.parse(req.headers.host).hostname;
  var match;
  req.explicitPort = false;
  if(!(match = req.headers.host.match(/^([^.]+)(.*)$/))) return res.status(404).send("Page Not Found");
  var portMatch;
  if(portMatch = match[1].match(/^(\w+)__(\d+)__$/)) {
    req.explicitPort = portMatch[2];
    match[1] = portMatch[1];
  }
  req.hostName = match[1]+match[2];
  req.logger.log('Service Name: '+ req.serviceName);
  if(!hosts[req.hostName]) {
    if(match[2] == '.'+config.defaultDomain){
      return request(config.docker+'/containers/'+match[1]+'/json', function(error, response, body) {
        if(!error && response.statusCode == 200) {
          try {
            body = JSON.parse(body);
            if(body.State.Running) {
              processService(body);
              return next();
            } else
              return res.status(503).send("Service  Unavailable");
          } catch(e) {
            req.logger.log(e);
          }
        }
        res.status(404).send("Page Not Found");
      });
    }
    return res.status(404).send("Page Not Found");
  }
  next()
}, function(req, res, next) {
  if(!hosts[req.hostName]) return res.status(500).send("Internal Server Error");
  var service = hosts[req.hostName];
  var options = {
    url: 'http://'+service.ip+':'+(req.explicitPort||service.port)+req.url,
    method: req.method,
    headers: req.headers
  };
  if(["POST", "PUT", "PATCH"].indexOf(req.method) !== -1) {
    options.body = req.body||'';
  }
  request(options, function(error, response, body) {
    if(error) {
      req.logger.log(error);
      return res.status(500).send(error);
    }
    res.set(response.headers);
    res.status(response.statusCode).send(body);
  });
});

app.listen(80);

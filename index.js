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
  var name = body.Name.substr(0, 1) == '/'?body.Name.substr(1):body.Name;
  services[name] = services[name]||{};
  if(!services[name].ip) services[name].ip = service.NetworkSettings.Networks.bridge.IPAddress;
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
      if (porst.indexOf(80)!==-1) {
        services[name].port = 80;
      } else if (porst.indexOf(443)!==-1) {
        services[name].port = 443;
      }
      services[name].port = ports[0];
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
  req.debugUrl = false;
  if(!(match = req.headers.host.match(/^([^.]+)(.*)$/))) return res.status(404).send("Page Not Found");
  var portMatch;
  if(portMatch = match[1].match(/^(\w)+__(\d)__$/)) {
    req.debugUrl = true;
    match[1] = match[1].substr(0, match[1].length-6);
  }
  req.serviceName = match[1];
  req.logger.log('Service Name: '+ req.serviceName);
  if(!services[req.serviceName]) {
    return request(config.docker+'/containers/'+req.serviceName+'/json', function(error, response, body) {
      if(!error && response.statusCode == 200) {
        try {
          body = JSON.parse(body);
          if(body.State.Running)
            processService(body);
            return next();
          else
            return res.status(503).send("Service  Unavailable");
        } catch(e) {
          req.logger.log(e);
        }
      }
      res.status(404).send("Page Not Found");
    });
  }
  next()
}, function(req, res, next) {
  fs.stat('/run/services/'+req.serviceName+(!req.debugUrl?'/service.sock':'/debug.sock'), function(error, stat) {
    if(error) return res.status(500).send("Internal Server Error");
    var headers = extend({}, req.headers);
    delete headers.host;
    var options = {
      url: 'http://unix:/run/services/'+req.serviceName+(!req.debugUrl?'/service.sock:':'/debug.sock:')+req.url,
      method: req.method,
      headers: headers
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
});

app.listen(80);

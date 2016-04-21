var express=require('express'),
    exec = require('child_process').exec,
    app = express(),
    request = require('request'),
    url = require('url'),
    fs = require('fs'),
    bodyParser = require('body-parser');

var services = [];
var fillServices = function() {
  //docker ps --format "{{.Names}}" -f "name=ci-jenk"|grep -w ci-jenk|wc -l
  exec('docker ps --format "{{.Names}}"', function(error, stdout, stderr) {
    if(!error) {
      services = stdout.split(/\s+/).filter(function(service) {
        return !!service;
      }).map(function(service) {
        return service.trim();
      });
    } else {
      services = [];
    }
  });
}
fillServices();
setInterval(fillServices, 10000);

/*app.use(function(req, res, next) {
  console.log(req.method+' '+req.url);
  next();
})*/

app.use(bodyParser.raw({limit: '50mb'}));

app.use(function(req, res, next) {
  //var hostname = url.parse(req.headers.host).hostname;
  var match;
  if(!(match = req.headers.host.match(/^([^.]+).*$/))) return res.status(404).send("Page Not Found");
  req.serviceName = match[1];
  if(services.indexOf(req.serviceName) === -1) {
    return exec('docker ps --format "{{.Names}}" -f "name='+req.servicesName+'" | grep -w '+req.servicesName+' | wc -l', function(error, stdout, stderr) {
      if(!error && stdout!=0) {
        return next();
      }
      res.status(404).send("Page Not Found");
    });
  }
  next()
}, function(req, res, next) {
  fs.stat('/run/services/'+req.serviceName+'/service.sock', function(error, stat) {
    if(error) return res.status(500).send("Internal Server Error");
    var options = {
      url: 'http://unix:/run/services/'+req.serviceName+'/service.sock:'+req.url,
      method: req.method,
      headers: req.headers
    };
    if(["POST", "PUT", "PATCH"].indexOf(req.method) !== -1) {
      options.body = req.body;
    }
    req.pipe(request(options)).pipe(res);
  });
});

app.listen(80);

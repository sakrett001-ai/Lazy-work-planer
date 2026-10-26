'use strict';
const fail=()=>{throw Error('Fake-only IPC tests deny IP networking and DNS');};
const net=require('node:net'),connect=net.Socket.prototype.connect,listen=net.Server.prototype.listen;
const unix=args=>{const a=Array.isArray(args[0])?args[0]:args,o=a[0];return (o&&typeof o==='object'&&typeof o.path==='string')||(typeof o==='string'&&!/^\d+$/.test(o));};
net.Socket.prototype.connect=function(...args){if(!unix(args))fail();return Reflect.apply(connect,this,args);};
net.Server.prototype.listen=function(...args){if(!unix(args))fail();return Reflect.apply(listen,this,args);};
require('node:dgram').createSocket=fail;
const dns=require('node:dns');for(const object of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype])for(const k of Object.getOwnPropertyNames(object))if(typeof object[k]==='function'&&(k==='lookup'||k.startsWith('resolve')||k==='reverse'))object[k]=fail;

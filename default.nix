# This file has been generated by node2nix 1.8.0. Do not edit!

{pkgs ? import <nixpkgs> {
    inherit system;
  }, system ? builtins.currentSystem, nodejs ? pkgs."nodejs-12_x"}:

let
  nodeEnv = import ./node-env.nix {
    inherit (pkgs) stdenv python2 utillinux runCommand writeTextFile;
    inherit nodejs;
    libtool = if pkgs.stdenv.isDarwin then pkgs.darwin.cctools else null;
  };
  prodPkgs = import ./node-packages.prod.nix {
    inherit (pkgs) fetchurl fetchgit;
    inherit nodeEnv;
  };
  develPkgs = import ./node-packages.devel.nix {
    inherit (pkgs) fetchurl fetchgit;
    inherit nodeEnv;
  };
  build = nodeEnv.buildNodePackage (develPkgs.args // {
    postInstall = ''npx webpack'';
  });
  prodBuild = nodeEnv.buildNodePackage (prodPkgs.args // {
    dontNpmInstall = true;
    postInstall = ''
      cp -R ${build}/lib/node_modules/zhaopengyou/dist .
      rm -rf src test Makefile *.nix
      mkdir -p $out/bin/

      cat >$out/bin/run.sh <<eof
      #!/usr/bin/env sh
      cd "$out/lib/node_modules/zhaopengyou/"
      exec ${nodejs}/bin/node dist/app/main.js
      eof

      chmod +x $out/bin/run.sh
    '';
  });
in
{
  shell = nodeEnv.buildNodeShell develPkgs.args;
  package = prodBuild;
}
import IPFS = require('ipfs')
import { create } from 'ipfs-http-client';
import type { OrbitDB as ODB } from 'orbit-db'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OrbitDB = require('orbit-db')
import { SingleBar, Presets } from 'cli-progress';
import { orbitDbFullPath, orbitDbDirectory, ipfsOptions, ipfsRemoteNode } from './config'
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';


let useHttpClient = false;

async function main()
{
  const argv = yargs(hideBin(process.argv))
    .option('serve', {
      type: 'boolean',
      description: 'Keep the node running',
    })
    .option('bootstrap', {
      type: 'string',
      description: 'Set the custom bootstrap node address, default: '+ipfsRemoteNode,
    })
    .option('ipfsapi', {
      type: 'string',
      description: 'Connect to this IPFS API endpoint instead of running an IPFS node, eg: http://127.0.0.1:5001/api/v0',
    })
    .option('ipfsdir', {
      type: 'string',
      description: 'Directory of the IPFS data',
    })
    .option('ipfsport', {
      type: 'string',
      description: 'Use a custom port for IPFS (defaults to 4001)',
    })
    .option('orbitdir', {
      type: 'string',
      description: 'Directory of the orbit DB',
    })
    .recommendCommands()
    .showHelpOnFail(true).argv;
  if (argv['ipfsapi']) {
    useHttpClient = true;
  }
  if (argv['ipfsdir']) {
    ipfsOptions.repo = argv['ipfsdir']
  }
  if (argv['ipfsport']) {
    ipfsOptions.config.Addresses.Swarm = ipfsOptions.config.Addresses.Swarm.map(a=>a.replace('4001', argv['ipfsport']))
  }
  if (argv['bootstrap']) {
    ipfsOptions.config.Bootstrap = [argv['bootstrap']]
  }

  // Create IPFS instance
  if (useHttpClient) {
    console.log(`=== Connecting to IPFS ${argv['ipfsapi']}`)
  } else {
    console.log('=== IPFS Bootstrap setting: ', ipfsOptions.config.Bootstrap)
    console.log('=== Starting IPFS')
  }
  const ipfs = useHttpClient ? ('local' === argv['ipfsapi'] ? create() : create({url: argv['ipfsapi']})) : await IPFS.create(ipfsOptions)

  // Create OrbitDB
  const orbitDir = argv['orbitdir'] || orbitDbDirectory
  console.log('=== Starting OrbitDB using directory: ', orbitDir)
  const orbitdb: ODB = await OrbitDB.createInstance(ipfs,{directory: orbitDir})
  const replicationBar = new SingleBar(
    {
      format:
      'Replicating OrbitDB |' +
        '{bar}' +
        '| {percentage}% | ETA: {eta}s | {value}/{total} chunks',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      etaBuffer: 50,
      etaAsynchronousUpdate: true,
    },
    Presets.shades_classic,
  )
  const loadingBar = new SingleBar(
    {
      format:
      'Loading OrbitDB |' +
        '{bar}' +
        '| {percentage}% | ETA: {eta}s | {value}/{total} chunks',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      etaBuffer: 50,
      etaAsynchronousUpdate: true,
    },
    Presets.shades_classic,
  )
  let replicationBarStarted = false;
  let loadingBarStarted = false;

  const stopBars = () => {
    if (replicationBarStarted) replicationBar.stop();
    if (loadingBarStarted) loadingBar.stop();
  }

  console.log('=== Making existing OrbitDB replica')

  const start = async () => {
    const db = await orbitdb.docstore(orbitDbFullPath)
    const done = async () => {
      stopBars();
      console.log('Done');

      if (argv['serve']) {
        console.log('OrbitDB Started ... (press CTRL-C to stop)')
      } else {
        console.log('=== Closing OrbitDB ...')
        await db.close()
        if (!useHttpClient) {
          console.log('=== Stopping IPFS, or press CTRL-C to terminate. ...')
          try {
            await ipfs.stop()
          } catch (err) {
            console.error('== Error stopping IPFS, should not matter.', err)
          }
          console.log('=== All stopped')
        } else {
          console.log('=== All stopped, press CTRL-C to terminate. ...')
        }
      }
    }

    db.events.on('load.progress', async (_address, _hash, _entry, progress, have) => {
      if (!loadingBarStarted) {
        console.log('Loading DB...')
        loadingBar.start(have, progress)
        loadingBarStarted = true
      } else {
        loadingBar.update(progress)
      }
    });
    db.events.on('ready', async () => {
      stopBars()
      console.log('OrbitDB ready')
      const loadedRes = db.get('')
      console.log(`Current number of records: ${loadedRes.length}`)
      // note do not call done if we were also somehow replicating or the number of record is 0
      if (replicationBarStarted || !loadedRes.length) return
      await done()
    });
    db.events.on('load', async (dbname) => {
      console.log('Loading OrbitDB: ', dbname)
    });
    db.events.on('replicate.progress', (_address, _hash, _entry, progress, have) => {
      if (!replicationBarStarted) {
        console.log('Starting replication...')
        replicationBar.start(have, progress)
        replicationBarStarted = true
      } else {
        replicationBar.update(progress)
      }
    });
    db.events.on('replicated', async () => {
      stopBars()
      const loadedRes = db.get('')
      console.log(`Replicated number of records: ${loadedRes.length}`)
      console.log('Reloading ...')
      replicationBarStarted = false
      await db.close()
      await start()
    });
    await db.load()
  }
  await start()
}
main()

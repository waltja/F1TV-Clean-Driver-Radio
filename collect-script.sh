#!/bin/bash
pnpm collect-noise --start-min 12 --end-min 100 --drivers 22
cat training-data/noise_*.raw >> /mnt/nas/noise2.raw
rm training-data/noise_*.raw

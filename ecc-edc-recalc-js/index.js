(function(self) {

  // LUTs for computing ECC/EDC
  const eccFLut = new Uint8Array(256)
  const eccBLut = new Uint8Array(256)
  const edcLut = new Uint32Array(256)

  function eccEdcInit() {
    for (let i = 0; i < 256; i++) {
      let j = (i << 1) ^ (i & 0x80 ? 0x11d : 0)
      eccFLut[i] = j & 0xff
      eccBLut[i^j] = i & 0xff
      let edc = i
      for (j = 0; j < 8; j++) {
        edc = (edc >>> 1) ^ (edc & 1 ? 0xd8018001 : 0)
      }
      edcLut[i] = edc
    }
  }

  function set32lsb(p, value) {
    p[0] = value >>> 0
    p[1] = value >>> 8
    p[2] = value >>> 16
    p[3] = value >>> 24
  }

  // Compute EDC for a block
  function edcComputeblock(src, size, dest) {
    let edc = 0
    let i = 0
    while (size--) {
      edc = (edc >>> 8) ^ edcLut[(edc ^ src[i++]) & 0xff]
    }
    set32lsb(dest, edc)
  }

  // Compute ECC for a block (can do either P or Q)
  function eccComputeblock(src, majorCount, minorCount, majorMult, minorInc, dest) {
    let size = majorCount * minorCount
    let major, minor
    for (major = 0; major < majorCount; major++) {
      index = (major >>> 1) * majorMult + (major & 1)
      let eccA = 0
      let eccB = 0
      for (minor = 0; minor < minorCount; minor++) {
        let temp = src[index]
        index += minorInc
        if (index >= size) {
          index -= size
        }
        eccA ^= temp
        eccB ^= temp
        eccA = eccFLut[eccA]
      }
      eccA = eccBLut[eccFLut[eccA] ^ eccB]
      dest[major] = eccA
      dest[major + majorCount] = eccA ^ eccB
    }
  }

  // Generate ECC P and Q codes for a block
  function eccGenerate(sector, zeroaddress) {
    const savedAddress = new Uint8Array(4)
    // Save the address and zero it out, if necessary
    if (zeroaddress) {
      // memmove(saved_address, sector + 12, 4);
      savedAddress.set(sector.subarray(12, 16))
      // memset(sector + 12, 0, 4);
      sector.fill(0, 12, 12 + 4)
    }
    // Compute ECC P code
    eccComputeblock(sector.subarray(0xc), 86, 24, 2, 86, sector.subarray(0x81c))
    // Compute ECC Q code
    eccComputeblock(sector.subarray(0xc), 52, 43, 86, 88, sector.subarray(0x8c8))
    // Restore the address, if necessary
    if (zeroaddress) {
      // memmove(sector + 12, saved_address, 4);
      sector.set(savedAddress, 12)
    }
  }

  // CD sync header
  const syncHeader = [ 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00 ]

  // Generate ECC/EDC information for a sector (must be 2352 = 0x930 bytes)
  function eccEdcGenerate(sector) {
    // Generate sync
    // memmove(sector, syncHeader, sizeof(syncHeader));
    sector.set(syncHeader)
    switch (sector[0x0f]) {
    case 0x00:
      // Mode 0: no data; generate zeroes
      // memset(sector + 0x10, 0, 0x920);
      sector.fill(0, 0x10, 0x10 + 0x920)
      break
    case 0x01:
      // Mode 1: Compute EDC
      edcComputeblock(sector, 0x810, sector.subarray(0x810))
      // Zero out reserved area
      // memset(sector + 0x814, 0, 8);
      sector.fill(0, 0x814, 0x814 + 8)
      // Generate ECC P/Q codes
      eccGenerate(sector, 0)
      break
    case 0x02:
      // Mode 2: Make sure XA flags match
      // memmove(sector + 0x14, sector + 0x10, 4);
      sector.set(sector.subarray(0x10, 0x10 + 4), 0x14)
      if (!(sector[0x12] & 0x20)) {
        // Form 1: Compute EDC
        edcComputeblock(sector.subarray(0x10), 0x808, sector.subarray(0x818))
        // Generate ECC P/Q codes
        eccGenerate(sector, 1)
      } else {
        // Form 2: Compute EDC
        edcComputeblock(sector.subarray(0x10), 0x91c, sector.subarray(0x92c))
      }
      break
    }
  }

  // Returns nonzero if any bytes in the array are nonzero
  function anyNonZero(data, len) {
    let i = 0
    for(; len; len--) {
      if (data[i++]) {
        return 1
      }
    }
    return 0
  }

  function memcmp(a, b, len) {
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) {
        return 1
      }
    }
    return 0
  }

  // Verify EDC for a sector (must be 2352 = 0x930 bytes)
  // Returns 0 on success
  function edcVerify(sector) {
    const myedc = new Uint8Array(4)
    // Verify sync
    if (memcmp(sector, syncHeader, syncHeader.length)) {
      return 1
    }
    switch(sector[0x0f]) {
    case 0x00:
      // Mode 0: no data; everything had better be zero
      return anyNonZero(sector.subarray(0x10), 0x920)
    case 0x01:
      // Mode 1
      edcComputeblock(sector, 0x810, myedc)
      return memcmp(myedc, sector.subarray(0x810), 4)
    case 0x02:
      // Mode 2: Verify that the XA type is correctly copied twice
      if (memcmp(sector.subarray(0x10), sector.subarray(0x14), 4)) {
        return 1
      }
      if (!(sector[0x12] & 0x20)) {
        // Form 1
        edcComputeblock(sector.subarray(0x10), 0x808, myedc)
        return memcmp(myedc, sector.subarray(0x818), 4)
      } else {
        // Form 2
        edcComputeblock(sector.subarray(0x10), 0x91c, myedc)
        return memcmp(myedc, sector.subarray(0x92c), 4)
      }
    }
    // Invalid mode
    return 1
  }

  // 1: looks like audio 0: normal
  function audioGuess(sector) {
    if (!memcmp(sector, syncHeader, syncHeader.length)
        && sector[0xd] < 0x60
        && sector[0xe] < 0x75
        && sector[0xf] < 3) {
      return 0
    }
    return 1
  }

  function eccEdcCalc(data) {
    eccEdcInit()
    if (edcVerify(data) !== 0) {
      throw new Error('error: sector 0 not a valid 2352 sector')
    }
    for (let sector = 16; sector < (data.length / 2352); sector++) {
      if (audioGuess(data.subarray(sector * 2352))) {
        console.warn("warning: sector " + sector + " looks like an audio sector, will recalculate earlier sectors only")
        break
      }
      eccEdcGenerate(data.subarray(sector * 2352))
    }
  }

  if (self) {
    self.eccEdcCalc = eccEdcCalc
  } else {
    module.exports = eccEdcCalc
  }
})(typeof(self) !== 'undefined' ? self : null)

#pragma once
#include "GTFS.h"
#include <string>

// Canonical snapshot declarations. The implemented binary format lives in
// src/snapshot.cpp (GTFSData::saveCompiledSnapshot/loadCompiledSnapshot) and
// GTFSData::snapshotVersion(). This header previously declared version 2,
// omitted frequencyCount, and exposed free functions that no longer exist.
// It now mirrors the implemented format (version 4) and only re-exports the
// live entry points; nothing in the build includes this header, so it is
// documentation/compatibility only.

namespace gtfs {

// Snapshot binary version. Must match GTFSData::snapshotVersion().
constexpr uint32_t SNAPSHOT_VERSION = 4;
constexpr uint32_t SNAPSHOT_MAGIC = 0x51444653; // 'QDFS'

struct SnapshotHeader {
    uint32_t magic = SNAPSHOT_MAGIC;
    uint32_t version = SNAPSHOT_VERSION;
    uint32_t archHash = 0;
    uint32_t headerSize = sizeof(SnapshotHeader);
    uint64_t fileSize = 0;
    uint32_t stringPoolCount = 0;
    uint32_t agencyCount = 0;
    uint32_t calendarCount = 0;
    uint32_t calendarDateCount = 0;
    uint32_t routeCount = 0;
    uint32_t stopCount = 0;
    uint32_t stopTimeCount = 0;
    uint32_t tripCount = 0;
    uint32_t transferCount = 0;
    uint32_t shapeCount = 0;
    uint32_t feedInfoCount = 0;
    uint32_t staticOccupancyCount = 0;
    uint32_t frequencyCount = 0;
    uint32_t checksum = 0; // crc32 of rest of file
};

static_assert(SNAPSHOT_VERSION == 4, "snapshot.h version must match GTFSData::snapshotVersion()");

}

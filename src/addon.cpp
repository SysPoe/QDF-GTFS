#include <napi.h>
#include "GTFS.h"
#include "gtfs_parser.cpp"
#include "gtfs_realtime.cpp"
#include <ctime>
#include <string_view>
#include <vector>
#include <functional>

// Simple logger interface
struct Logger {
    Napi::ThreadSafeFunction tsfn;
    bool ansi;
};

class GTFSWorker : public Napi::AsyncWorker {
public:
    GTFSWorker(Napi::Env env, std::vector<unsigned char>&& zipData, gtfs::GTFSData* targetData, Logger logger)
        : Napi::AsyncWorker(env, "GTFSWorker"), deferred(Napi::Promise::Deferred::New(env)), zipData(std::move(zipData)), targetData(targetData), logger(logger) {}

    ~GTFSWorker() {
        if (logger.tsfn) {
            logger.tsfn.Release();
        }
    }

    void Execute() override {
        try {
            // Callback wrapper for gtfs_parser
            auto logCallback = [this](const std::string& msg) {
                if (!logger.tsfn) return;
                
                std::string formattedMsg = msg;
                if (logger.ansi) {
                    // Simple ANSI coloring (Green for success/loading)
                    formattedMsg = "\033[32m" + msg + "\033[0m";
                } else {
                    formattedMsg = msg;
                }

                auto callback = [formattedMsg](Napi::Env env, Napi::Function jsCallback) {
                    jsCallback.Call({Napi::String::New(env, formattedMsg)});
                };
                
                logger.tsfn.BlockingCall(callback);
            };

            gtfs::load_from_zip(*targetData, zipData.data(), zipData.size(), logCallback);
        } catch (const std::exception& e) {
            SetError(e.what());
        }
    }

    void OnOK() override {
        deferred.Resolve(Env().Null());
    }

    void OnError(const Napi::Error& e) override {
        deferred.Reject(e.Value());
    }
    
    Napi::Promise GetPromise() { return deferred.Promise(); }

private:
    Napi::Promise::Deferred deferred;
    std::vector<unsigned char> zipData;
    gtfs::GTFSData* targetData;
    Logger logger;
};

class GTFSAddon : public Napi::ObjectWrap<GTFSAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    GTFSAddon(const Napi::CallbackInfo& info);

    gtfs::GTFSData data; 

private:
    Napi::Value LoadFromBuffer(const Napi::CallbackInfo& info);
    Napi::Value GetRoutes(const Napi::CallbackInfo& info);
    Napi::Value GetRoute(const Napi::CallbackInfo& info);
    Napi::Value GetAgencies(const Napi::CallbackInfo& info);
    Napi::Value GetStops(const Napi::CallbackInfo& info);
    Napi::Value GetStopTimesForTrip(const Napi::CallbackInfo& info);
    Napi::Value QueryStopTimes(const Napi::CallbackInfo& info); 
    Napi::Value GetFeedInfo(const Napi::CallbackInfo& info);
    Napi::Value GetTrips(const Napi::CallbackInfo& info);
    Napi::Value GetShapes(const Napi::CallbackInfo& info);
    Napi::Value GetCalendars(const Napi::CallbackInfo& info);
    Napi::Value GetCalendarDates(const Napi::CallbackInfo& info);
    Napi::Value UpdateRealtime(const Napi::CallbackInfo& info);
    Napi::Value GetRealtimeTripUpdates(const Napi::CallbackInfo& info);
    Napi::Value GetRealtimeVehiclePositions(const Napi::CallbackInfo& info);
    Napi::Value GetRealtimeAlerts(const Napi::CallbackInfo& info);

    // Helpers
    bool IsServiceActive(const std::string& service_id, const std::string& date_str);
    int GetDayOfWeek(const std::string& date_str);
};

// --- Helpers ---
int GTFSAddon::GetDayOfWeek(const std::string& date_str) {
    if (date_str.length() != 8) return -1;
    try {
        int y = std::stoi(date_str.substr(0, 4));
        int m = std::stoi(date_str.substr(4, 2));
        int d = std::stoi(date_str.substr(6, 2));

        std::tm time_in = {};

        time_in.tm_mday = d;
        time_in.tm_mon  = m - 1;
        time_in.tm_year = y - 1900;
        time_in.tm_isdst = -1; // Let system determine DST

        std::time_t time_temp = std::mktime(&time_in);

        if (time_temp == -1) return -1;
        const std::tm * time_out = std::localtime(&time_temp);
        
        return time_out->tm_wday;
    } catch(...) {
        return -1;
    }
}

// Logic to check service active, used by QueryStopTimes with caching
bool CheckServiceActiveLogic(const gtfs::GTFSData& data, const std::string& service_id, const std::string& date_str, int wday) {
    if (data.calendar_dates.count(service_id)) {
        const auto& dates = data.calendar_dates.at(service_id);
        if (dates.count(date_str)) {
            int exception = dates.at(date_str);
            if (exception == 1) return true; 
            if (exception == 2) return false; 
        }
    }

    if (data.calendars.count(service_id)) {
        const auto& cal = data.calendars.at(service_id);
        if (date_str < cal.start_date || date_str > cal.end_date) {
            return false;
        }
        switch (wday) {
            case 0: return cal.sunday;
            case 1: return cal.monday;
            case 2: return cal.tuesday;
            case 3: return cal.wednesday;
            case 4: return cal.thursday;
            case 5: return cal.friday;
            case 6: return cal.saturday;
            default: return false;
        }
    }
    return false; 
}

Napi::Object GTFSAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "GTFSAddon", {
        InstanceMethod("loadFromBuffer", &GTFSAddon::LoadFromBuffer),
        InstanceMethod("getRoutes", &GTFSAddon::GetRoutes),
        InstanceMethod("getRoute", &GTFSAddon::GetRoute),
        InstanceMethod("getAgencies", &GTFSAddon::GetAgencies),
        InstanceMethod("getStops", &GTFSAddon::GetStops),
        InstanceMethod("getStopTimesForTrip", &GTFSAddon::GetStopTimesForTrip),
        InstanceMethod("queryStopTimes", &GTFSAddon::QueryStopTimes),
        InstanceMethod("getFeedInfo", &GTFSAddon::GetFeedInfo),
        InstanceMethod("getTrips", &GTFSAddon::GetTrips),
        InstanceMethod("getShapes", &GTFSAddon::GetShapes),
        InstanceMethod("getCalendars", &GTFSAddon::GetCalendars),
        InstanceMethod("getCalendarDates", &GTFSAddon::GetCalendarDates),
        InstanceMethod("updateRealtime", &GTFSAddon::UpdateRealtime),
        InstanceMethod("getRealtimeTripUpdates", &GTFSAddon::GetRealtimeTripUpdates),
        InstanceMethod("getRealtimeVehiclePositions", &GTFSAddon::GetRealtimeVehiclePositions),
        InstanceMethod("getRealtimeAlerts", &GTFSAddon::GetRealtimeAlerts)
    });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);

    exports.Set("GTFSAddon", func);
    return exports;
}

GTFSAddon::GTFSAddon(const Napi::CallbackInfo& info) : Napi::ObjectWrap<GTFSAddon>(info) {
}

Napi::Value GTFSAddon::LoadFromBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Buffer expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<unsigned char> buffer = info[0].As<Napi::Buffer<unsigned char>>();
    std::vector<unsigned char> zipData(buffer.Data(), buffer.Data() + buffer.Length());

    // Logger setup
    Logger logger = { nullptr, false };
    if (info.Length() > 1 && info[1].IsFunction()) {
        logger.tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "GTFSLogger", 0, 1);
    }
    if (info.Length() > 2 && info[2].IsBoolean()) {
        logger.ansi = info[2].As<Napi::Boolean>().Value();
    }

    auto worker = new GTFSWorker(env, std::move(zipData), &data, logger);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value GTFSAddon::GetRoute(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string route_id = info[0].As<Napi::String>().Utf8Value();
    if (data.routes.find(route_id) != data.routes.end()) {
        auto& r = data.routes[route_id];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("route_id", r.route_id);
        obj.Set("agency_id", r.agency_id);
        obj.Set("route_short_name", r.route_short_name);
        obj.Set("route_long_name", r.route_long_name);
        obj.Set("route_desc", r.route_desc);
        obj.Set("route_type", r.route_type);
        obj.Set("route_url", r.route_url);
        obj.Set("route_color", r.route_color);
        obj.Set("route_text_color", r.route_text_color);
        return obj;
    }
    return env.Null();
}

Napi::Value GTFSAddon::GetRoutes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.routes.size());
    int i = 0;
    for (const auto& [id, r] : data.routes) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("route_id", r.route_id);
        obj.Set("agency_id", r.agency_id);
        obj.Set("route_short_name", r.route_short_name);
        obj.Set("route_long_name", r.route_long_name);
        obj.Set("route_desc", r.route_desc);
        obj.Set("route_type", r.route_type);
        obj.Set("route_url", r.route_url);
        obj.Set("route_color", r.route_color);
        obj.Set("route_text_color", r.route_text_color);
        obj.Set("continuous_pickup", r.continuous_pickup);
        obj.Set("continuous_drop_off", r.continuous_drop_off);
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::UpdateRealtime(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
         Napi::TypeError::New(env, "Expected 3 arguments: alerts, tripUpdates, vehiclePositions").ThrowAsJavaScriptException();
         return env.Null();
    }

    // Clear old realtime data? Or just append?
    // Usually updates replace the state.
    // Let's clear first.
    data.realtime_trip_updates.clear();
    data.realtime_vehicle_positions.clear();
    data.realtime_alerts.clear();

    // 1. Alerts
    if (info[0].IsBuffer()) {
        Napi::Buffer<unsigned char> buf = info[0].As<Napi::Buffer<unsigned char>>();
        gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 2);
    }

    // 2. TripUpdates
    if (info[1].IsBuffer()) {
        Napi::Buffer<unsigned char> buf = info[1].As<Napi::Buffer<unsigned char>>();
        gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 0);
    }

    // 3. VehiclePositions
    if (info[2].IsBuffer()) {
        Napi::Buffer<unsigned char> buf = info[2].As<Napi::Buffer<unsigned char>>();
        gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 1);
    }

    return env.Null();
}

Napi::Value GTFSAddon::GetRealtimeTripUpdates(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.realtime_trip_updates.size());
    for (size_t i = 0; i < data.realtime_trip_updates.size(); ++i) {
        const auto& tu = data.realtime_trip_updates[i];
        Napi::Object obj = Napi::Object::New(env);

        obj.Set("update_id", tu.update_id);
        obj.Set("is_deleted", tu.is_deleted);

        Napi::Object trip = Napi::Object::New(env);
        trip.Set("trip_id", tu.trip.trip_id);
        trip.Set("route_id", tu.trip.route_id);
        trip.Set("direction_id", tu.trip.direction_id);
        trip.Set("start_time", tu.trip.start_time);
        trip.Set("start_date", tu.trip.start_date);
        trip.Set("schedule_relationship", tu.trip.schedule_relationship);
        obj.Set("trip", trip);

        Napi::Object vehicle = Napi::Object::New(env);
        vehicle.Set("id", tu.vehicle.id);
        vehicle.Set("label", tu.vehicle.label);
        vehicle.Set("license_plate", tu.vehicle.license_plate);
        obj.Set("vehicle", vehicle);

        Napi::Array stus = Napi::Array::New(env, tu.stop_time_updates.size());
        for (size_t j = 0; j < tu.stop_time_updates.size(); ++j) {
            const auto& stu = tu.stop_time_updates[j];
            Napi::Object stu_obj = Napi::Object::New(env);
            stu_obj.Set("stop_sequence", stu.stop_sequence);
            stu_obj.Set("stop_id", stu.stop_id);
            stu_obj.Set("trip_id", stu.trip_id);
            stu_obj.Set("arrival_delay", stu.arrival_delay);
            stu_obj.Set("arrival_time", stu.arrival_time);
            stu_obj.Set("departure_delay", stu.departure_delay);
            stu_obj.Set("departure_time", stu.departure_time);
            stu_obj.Set("schedule_relationship", stu.schedule_relationship);
            stus[j] = stu_obj;
        }
        obj.Set("stop_time_updates", stus);
        obj.Set("timestamp", (double)tu.timestamp); // JS Numbers are doubles, limited precision for uint64 but usually fine for timestamps
        obj.Set("delay", tu.delay);

        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetRealtimeVehiclePositions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.realtime_vehicle_positions.size());
    for (size_t i = 0; i < data.realtime_vehicle_positions.size(); ++i) {
        const auto& vp = data.realtime_vehicle_positions[i];
        Napi::Object obj = Napi::Object::New(env);

        obj.Set("update_id", vp.update_id);
        obj.Set("is_deleted", vp.is_deleted);

        Napi::Object trip = Napi::Object::New(env);
        trip.Set("trip_id", vp.trip.trip_id);
        trip.Set("route_id", vp.trip.route_id);
        trip.Set("direction_id", vp.trip.direction_id);
        trip.Set("start_time", vp.trip.start_time);
        trip.Set("start_date", vp.trip.start_date);
        trip.Set("schedule_relationship", vp.trip.schedule_relationship);
        obj.Set("trip", trip);

        Napi::Object vehicle = Napi::Object::New(env);
        vehicle.Set("id", vp.vehicle.id);
        vehicle.Set("label", vp.vehicle.label);
        vehicle.Set("license_plate", vp.vehicle.license_plate);
        obj.Set("vehicle", vehicle);

        Napi::Object position = Napi::Object::New(env);
        position.Set("latitude", vp.position.latitude);
        position.Set("longitude", vp.position.longitude);
        position.Set("bearing", vp.position.bearing);
        position.Set("odometer", vp.position.odometer);
        position.Set("speed", vp.position.speed);
        obj.Set("position", position);

        obj.Set("current_stop_sequence", vp.current_stop_sequence);
        obj.Set("stop_id", vp.stop_id);
        obj.Set("current_status", vp.current_status);
        obj.Set("timestamp", (double)vp.timestamp);
        obj.Set("congestion_level", vp.congestion_level);
        obj.Set("occupancy_status", vp.occupancy_status);
        obj.Set("occupancy_percentage", vp.occupancy_percentage);

        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetRealtimeAlerts(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.realtime_alerts.size());
    for (size_t i = 0; i < data.realtime_alerts.size(); ++i) {
        const auto& a = data.realtime_alerts[i];
        Napi::Object obj = Napi::Object::New(env);

        obj.Set("update_id", a.update_id);
        obj.Set("is_deleted", a.is_deleted);

        // Active periods omitted for brevity/complexity mapping for now

        obj.Set("cause", a.cause);
        obj.Set("effect", a.effect);
        obj.Set("url", a.url);
        obj.Set("header_text", a.header_text);
        obj.Set("description_text", a.description_text);
        obj.Set("severity_level", a.severity_level);

        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetAgencies(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.agencies.size());
    int i = 0;
    for (const auto& [id, a] : data.agencies) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("agency_id", a.agency_id);
        obj.Set("agency_name", a.agency_name);
        obj.Set("agency_url", a.agency_url);
        obj.Set("agency_timezone", a.agency_timezone);
        obj.Set("agency_lang", a.agency_lang);
        obj.Set("agency_phone", a.agency_phone);
        obj.Set("agency_fare_url", a.agency_fare_url);
        obj.Set("agency_email", a.agency_email);
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetStops(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.stops.size());
    int i = 0;
    for (const auto& [id, s] : data.stops) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("stop_id", s.stop_id);
        obj.Set("stop_code", s.stop_code);
        obj.Set("stop_name", s.stop_name);
        obj.Set("stop_desc", s.stop_desc);
        obj.Set("stop_lat", s.stop_lat);
        obj.Set("stop_lon", s.stop_lon);
        obj.Set("zone_id", s.zone_id);
        obj.Set("stop_url", s.stop_url);
        obj.Set("location_type", s.location_type);
        obj.Set("parent_station", s.parent_station);
        obj.Set("stop_timezone", s.stop_timezone);
        obj.Set("wheelchair_boarding", s.wheelchair_boarding);
        obj.Set("level_id", s.level_id);
        obj.Set("platform_code", s.platform_code);
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetStopTimesForTrip(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
         Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
         return env.Null();
    }
    std::string trip_id_str = info[0].As<Napi::String>().Utf8Value();
    
    uint32_t trip_id = data.string_pool.get_id(trip_id_str);
    if (trip_id == 0xFFFFFFFF) {
        return Napi::Array::New(env, 0); // Trip not found
    }
    
    // Binary search because stop_times is sorted by trip_id
    gtfs::StopTime target;
    target.trip_id = trip_id;
    
    auto range = std::equal_range(data.stop_times.begin(), data.stop_times.end(), target, 
        [](const gtfs::StopTime& a, const gtfs::StopTime& b) {
            return a.trip_id < b.trip_id;
        }
    );

    size_t count = std::distance(range.first, range.second);
    Napi::Array arr = Napi::Array::New(env, count);
    
    size_t i = 0;
    for(auto it = range.first; it != range.second; ++it) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("trip_id", data.string_pool.get(it->trip_id));
        obj.Set("arrival_time", it->arrival_time);
        obj.Set("departure_time", it->departure_time);
        obj.Set("stop_id", data.string_pool.get(it->stop_id));
        obj.Set("stop_sequence", it->stop_sequence);
        obj.Set("stop_headsign", data.string_pool.get(it->stop_headsign));
        obj.Set("pickup_type", it->pickup_type);
        obj.Set("drop_off_type", it->drop_off_type);
        obj.Set("shape_dist_traveled", it->shape_dist_traveled);
        obj.Set("timepoint", it->timepoint);
        obj.Set("continuous_pickup", it->continuous_pickup);
        obj.Set("continuous_drop_off", it->continuous_drop_off);
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::QueryStopTimes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Configuration object expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object config = info[0].As<Napi::Object>();
    
    // Extract parameters
    
    // Trip ID Filter
    bool has_trip_id = false;
    uint32_t filter_trip_id = 0xFFFFFFFF;
    if (config.Has("trip_id") && config.Get("trip_id").IsString()) {
        std::string s = config.Get("trip_id").As<Napi::String>().Utf8Value();
        filter_trip_id = data.string_pool.get_id(s);
        if (filter_trip_id == 0xFFFFFFFF) return Napi::Array::New(env, 0); // Fast exit if string not in pool
        has_trip_id = true;
    }

    // Stop ID Filter
    bool has_stop_id = false;
    uint32_t filter_stop_id = 0xFFFFFFFF;
    if (config.Has("stop_id") && config.Get("stop_id").IsString()) {
        std::string s = config.Get("stop_id").As<Napi::String>().Utf8Value();
        filter_stop_id = data.string_pool.get_id(s);
        if (filter_stop_id == 0xFFFFFFFF) return Napi::Array::New(env, 0); // Fast exit
        has_stop_id = true;
    }

    int filter_start_time = -1;
    int filter_end_time = -1;
    if (config.Has("start_time")) {
        Napi::Value v = config.Get("start_time");
        if (v.IsNumber()) filter_start_time = v.As<Napi::Number>().Int32Value();
        else if (v.IsString()) filter_start_time = gtfs::parse_time_seconds(v.As<Napi::String>().Utf8Value());
    }
    if (config.Has("end_time")) {
        Napi::Value v = config.Get("end_time");
        if (v.IsNumber()) filter_end_time = v.As<Napi::Number>().Int32Value();
        else if (v.IsString()) filter_end_time = gtfs::parse_time_seconds(v.As<Napi::String>().Utf8Value());
    }
    bool has_time_window = (filter_start_time != -1 && filter_end_time != -1);

    std::string filter_date;
    bool has_date = false;
    int date_wday = -1;
    if (config.Has("date") && config.Get("date").IsString()) {
        filter_date = config.Get("date").As<Napi::String>().Utf8Value();
        date_wday = GetDayOfWeek(filter_date);
        has_date = (date_wday != -1); 
    }

    std::vector<const gtfs::StopTime*> results;
    std::unordered_map<std::string, bool> service_cache;

    if (has_trip_id) {
        gtfs::StopTime target;
        target.trip_id = filter_trip_id;
        
        auto range = std::equal_range(data.stop_times.begin(), data.stop_times.end(), target, 
            [](const gtfs::StopTime& a, const gtfs::StopTime& b) {
                return a.trip_id < b.trip_id;
            }
        );

        for (auto it = range.first; it != range.second; ++it) {
            const gtfs::StopTime& st = *it;
            // Stop ID Check (using int compare)
            if (has_stop_id && st.stop_id != filter_stop_id) continue;

            // Time Check
            if (has_time_window) {
                bool arrival_in = (st.arrival_time >= filter_start_time && st.arrival_time <= filter_end_time);
                bool departure_in = (st.departure_time >= filter_start_time && st.departure_time <= filter_end_time);
                if (!arrival_in && !departure_in) continue;
            }

            // Date Check
            if (has_date) {
                std::string trip_id_str = data.string_pool.get(st.trip_id); // Need string to lookup Trip info
                if (data.trips.count(trip_id_str)) {
                    const std::string& service_id = data.trips.at(trip_id_str).service_id;
                    
                    bool active = false;
                    if (service_cache.count(service_id)) {
                        active = service_cache.at(service_id);
                    } else {
                        active = CheckServiceActiveLogic(data, service_id, filter_date, date_wday);
                        service_cache[service_id] = active;
                    }
                    if (!active) continue;
                } else {
                    continue; 
                }
            }

            results.push_back(&st);
        }

    } else if (has_stop_id) {
        if (data.stop_times_by_stop_id.count(filter_stop_id)) {
            const auto& indices = data.stop_times_by_stop_id.at(filter_stop_id);
            for (size_t idx : indices) {
                const gtfs::StopTime& st = data.stop_times[idx];

                if (has_trip_id && st.trip_id != filter_trip_id) continue;

                if (has_time_window) {
                    bool arrival_in = (st.arrival_time >= filter_start_time && st.arrival_time <= filter_end_time);
                    bool departure_in = (st.departure_time >= filter_start_time && st.departure_time <= filter_end_time);
                    if (!arrival_in && !departure_in) continue;
                }

                if (has_date) {
                    std::string trip_id_str = data.string_pool.get(st.trip_id);
                    if (data.trips.count(trip_id_str)) {
                        const std::string& service_id = data.trips.at(trip_id_str).service_id;
                        bool active = false;
                        if (service_cache.count(service_id)) {
                            active = service_cache.at(service_id);
                        } else {
                            active = CheckServiceActiveLogic(data, service_id, filter_date, date_wday);
                            service_cache[service_id] = active;
                        }
                        if (!active) continue;
                    } else {
                        continue;
                    }
                }
                
                results.push_back(&st);
            }
        }
    } else {
        // Full Scan
        for (const auto& st : data.stop_times) {
            if (has_trip_id && st.trip_id != filter_trip_id) continue;
            if (has_stop_id && st.stop_id != filter_stop_id) continue;
            
            if (has_time_window) {
                bool arrival_in = (st.arrival_time >= filter_start_time && st.arrival_time <= filter_end_time);
                bool departure_in = (st.departure_time >= filter_start_time && st.departure_time <= filter_end_time);
                if (!arrival_in && !departure_in) continue;
            }

            if (has_date) {
                std::string trip_id_str = data.string_pool.get(st.trip_id);
                if (data.trips.count(trip_id_str)) {
                    const std::string& service_id = data.trips.at(trip_id_str).service_id;
                    bool active = false;
                    if (service_cache.count(service_id)) {
                        active = service_cache.at(service_id);
                    } else {
                        active = CheckServiceActiveLogic(data, service_id, filter_date, date_wday);
                        service_cache[service_id] = active;
                    }
                    if (!active) continue;
                } else {
                    continue;
                }
            }
            results.push_back(&st);
        }
    }

    Napi::Array arr = Napi::Array::New(env, results.size());
    for(size_t i = 0; i < results.size(); ++i) {
        const gtfs::StopTime* st = results[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("trip_id", data.string_pool.get(st->trip_id));
        obj.Set("arrival_time", st->arrival_time);
        obj.Set("departure_time", st->departure_time);
        obj.Set("stop_id", data.string_pool.get(st->stop_id));
        obj.Set("stop_sequence", st->stop_sequence);
        obj.Set("stop_headsign", data.string_pool.get(st->stop_headsign));
        obj.Set("pickup_type", st->pickup_type);
        obj.Set("drop_off_type", st->drop_off_type);
        obj.Set("shape_dist_traveled", st->shape_dist_traveled);
        obj.Set("timepoint", st->timepoint);
        obj.Set("continuous_pickup", st->continuous_pickup);
        obj.Set("continuous_drop_off", st->continuous_drop_off);
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetFeedInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.feed_info.size());
    for (size_t i = 0; i < data.feed_info.size(); ++i) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("feed_publisher_name", data.feed_info[i].feed_publisher_name);
        obj.Set("feed_publisher_url", data.feed_info[i].feed_publisher_url);
        obj.Set("feed_lang", data.feed_info[i].feed_lang);
        obj.Set("default_lang", data.feed_info[i].default_lang);
        obj.Set("feed_start_date", data.feed_info[i].feed_start_date);
        obj.Set("feed_end_date", data.feed_info[i].feed_end_date);
        obj.Set("feed_version", data.feed_info[i].feed_version);
        obj.Set("feed_contact_email", data.feed_info[i].feed_contact_email);
        obj.Set("feed_contact_url", data.feed_info[i].feed_contact_url);
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetTrips(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.trips.size());
    int i = 0;
    for (const auto& [id, t] : data.trips) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("trip_id", t.trip_id);
        obj.Set("route_id", t.route_id);
        obj.Set("service_id", t.service_id);
        obj.Set("trip_headsign", t.trip_headsign);
        obj.Set("trip_short_name", t.trip_short_name);
        obj.Set("direction_id", t.direction_id);
        obj.Set("block_id", t.block_id);
        obj.Set("shape_id", t.shape_id);
        obj.Set("wheelchair_accessible", t.wheelchair_accessible);
        obj.Set("bikes_allowed", t.bikes_allowed);
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetShapes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.shapes.size());
    for (size_t i = 0; i < data.shapes.size(); ++i) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("shape_id", data.shapes[i].shape_id);
        obj.Set("shape_pt_lat", data.shapes[i].shape_pt_lat);
        obj.Set("shape_pt_lon", data.shapes[i].shape_pt_lon);
        obj.Set("shape_pt_sequence", data.shapes[i].shape_pt_sequence);
        obj.Set("shape_dist_traveled", data.shapes[i].shape_dist_traveled);
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetCalendars(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, data.calendars.size());
    int i = 0;
    for (const auto& [id, c] : data.calendars) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("service_id", c.service_id);
        obj.Set("monday", c.monday);
        obj.Set("tuesday", c.tuesday);
        obj.Set("wednesday", c.wednesday);
        obj.Set("thursday", c.thursday);
        obj.Set("friday", c.friday);
        obj.Set("saturday", c.saturday);
        obj.Set("sunday", c.sunday);
        obj.Set("start_date", c.start_date);
        obj.Set("end_date", c.end_date);
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetCalendarDates(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    // Flatten the optimized map map structure for export
    std::vector<gtfs::CalendarDate> flat_list;
    for (const auto& [service_id, dates] : data.calendar_dates) {
        for (const auto& [date, exc] : dates) {
            gtfs::CalendarDate cd;
            cd.service_id = service_id;
            cd.date = date;
            cd.exception_type = exc;
            flat_list.push_back(cd);
        }
    }

    Napi::Array arr = Napi::Array::New(env, flat_list.size());
    for (size_t i = 0; i < flat_list.size(); ++i) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("service_id", flat_list[i].service_id);
        obj.Set("date", flat_list[i].date);
        obj.Set("exception_type", flat_list[i].exception_type);
        arr[i] = obj;
    }
    return arr;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return GTFSAddon::Init(env, exports);
}

NODE_API_MODULE(gtfs_addon, Init)

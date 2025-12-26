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
    Napi::ThreadSafeFunction progress_tsfn;
    bool ansi;
};

class GTFSWorker : public Napi::AsyncWorker {
public:
    GTFSWorker(Napi::Env env, std::vector<std::vector<unsigned char>>&& zipBuffers, int mergeStrategy, gtfs::GTFSData* targetData, Logger logger)
        : Napi::AsyncWorker(env, "GTFSWorker"), deferred(Napi::Promise::Deferred::New(env)), zipBuffers(std::move(zipBuffers)), mergeStrategy(mergeStrategy), targetData(targetData), logger(logger) {}

    ~GTFSWorker() {
        if (logger.tsfn) {
            logger.tsfn.Release();
        }
        if (logger.progress_tsfn) {
            logger.progress_tsfn.Release();
        }
    }

    void Execute() override {
        try {
            auto logCallback = [this](const std::string& msg) {
                if (!logger.tsfn) return;
                
                std::string formattedMsg = msg;
                if (logger.ansi) {
                    formattedMsg = "\033[32m" + msg + "\033[0m";
                } else {
                    formattedMsg = msg;
                }

                auto callback = [formattedMsg](Napi::Env env, Napi::Function jsCallback) {
                    jsCallback.Call({Napi::String::New(env, formattedMsg)});
                };
                
                logger.tsfn.BlockingCall(callback);
            };

            auto progressCallback = [this](std::string task, int64_t current, int64_t total) {
                if (!logger.progress_tsfn) return;

                auto callback = [task, current, total](Napi::Env env, Napi::Function jsCallback) {
                    jsCallback.Call({
                        Napi::String::New(env, task),
                        Napi::Number::New(env, current),
                        Napi::Number::New(env, total)
                    });
                };
                logger.progress_tsfn.BlockingCall(callback);
            };

            gtfs::load_feeds(*targetData, zipBuffers, mergeStrategy, logCallback, progressCallback);
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
    std::vector<std::vector<unsigned char>> zipBuffers;
    int mergeStrategy;
    gtfs::GTFSData* targetData;
    Logger logger;
};

class GTFSAddon : public Napi::ObjectWrap<GTFSAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    GTFSAddon(const Napi::CallbackInfo& info);

    gtfs::GTFSData data; 

private:
    Napi::Value LoadFromBuffers(const Napi::CallbackInfo& info);
    Napi::Value GetRoutes(const Napi::CallbackInfo& info);
    Napi::Value GetAgencies(const Napi::CallbackInfo& info);
    Napi::Value GetStops(const Napi::CallbackInfo& info);
    Napi::Value GetStopTimes(const Napi::CallbackInfo& info);
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
        time_in.tm_isdst = -1;

        std::time_t time_temp = std::mktime(&time_in);

        if (time_temp == -1) return -1;
        const std::tm * time_out = std::localtime(&time_temp);
        
        return time_out->tm_wday;
    } catch(...) {
        return -1;
    }
}

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
        InstanceMethod("loadFromBuffers", &GTFSAddon::LoadFromBuffers),
        InstanceMethod("getRoutes", &GTFSAddon::GetRoutes),
        InstanceMethod("getAgencies", &GTFSAddon::GetAgencies),
        InstanceMethod("getStops", &GTFSAddon::GetStops),
        InstanceMethod("getStopTimes", &GTFSAddon::GetStopTimes),
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

Napi::Value GTFSAddon::LoadFromBuffers(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Array of buffers expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array arr = info[0].As<Napi::Array>();
    std::vector<std::vector<unsigned char>> zipBuffers;
    for (uint32_t i = 0; i < arr.Length(); ++i) {
        Napi::Value val = arr[i];
        if (val.IsBuffer()) {
            Napi::Buffer<unsigned char> buffer = val.As<Napi::Buffer<unsigned char>>();
            zipBuffers.emplace_back(buffer.Data(), buffer.Data() + buffer.Length());
        }
    }

    int mergeStrategy = 0;
    if (info.Length() > 1 && info[1].IsNumber()) {
        mergeStrategy = info[1].As<Napi::Number>().Int32Value();
    }

    Logger logger = { nullptr, nullptr, false };
    if (info.Length() > 2 && info[2].IsFunction()) {
        logger.tsfn = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "GTFSLogger", 0, 1);
    }
    if (info.Length() > 3 && info[3].IsBoolean()) {
        logger.ansi = info[3].As<Napi::Boolean>().Value();
    }
    if (info.Length() > 4 && info[4].IsFunction()) {
        logger.progress_tsfn = Napi::ThreadSafeFunction::New(env, info[4].As<Napi::Function>(), "GTFSProgress", 0, 1);
    }

    auto worker = new GTFSWorker(env, std::move(zipBuffers), mergeStrategy, &data, logger);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value GTFSAddon::GetAgencies(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    std::vector<const gtfs::Agency*> matches;
    matches.reserve(data.agencies.size());

    if (has_filter && filter.Has("agency_id")) {
        std::string id = filter.Get("agency_id").As<Napi::String>().Utf8Value();
        if (data.agencies.count(id)) {
            matches.push_back(&data.agencies.at(id));
        }
    } else {
        for (const auto& [id, a] : data.agencies) {
            matches.push_back(&a);
        }
    }

    Napi::Array arr = Napi::Array::New(env, matches.size());
    for (size_t i = 0; i < matches.size(); ++i) {
        const auto& a = *matches[i];
        Napi::Object obj = Napi::Object::New(env);
        if (a.agency_id.has_value()) obj.Set("agency_id", a.agency_id.value()); else obj.Set("agency_id", env.Null());
        obj.Set("agency_name", a.agency_name);
        obj.Set("agency_url", a.agency_url);
        obj.Set("agency_timezone", a.agency_timezone);
        if (a.agency_lang.has_value()) obj.Set("agency_lang", a.agency_lang.value()); else obj.Set("agency_lang", env.Null());
        if (a.agency_phone.has_value()) obj.Set("agency_phone", a.agency_phone.value()); else obj.Set("agency_phone", env.Null());
        if (a.agency_fare_url.has_value()) obj.Set("agency_fare_url", a.agency_fare_url.value()); else obj.Set("agency_fare_url", env.Null());
        if (a.agency_email.has_value()) obj.Set("agency_email", a.agency_email.value()); else obj.Set("agency_email", env.Null());
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetRoutes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    std::vector<const gtfs::Route*> matches;
    matches.reserve(data.routes.size());

    if (has_filter && filter.Has("route_id")) {
        std::string id = filter.Get("route_id").As<Napi::String>().Utf8Value();
        if (data.routes.count(id)) {
             const auto& r = data.routes.at(id);
             bool ok = true;
             if (filter.Has("agency_id")) {
                std::string v = filter.Get("agency_id").As<Napi::String>().Utf8Value();
                if (!r.agency_id.has_value() || r.agency_id.value() != v) ok = false;
             }
             if (filter.Has("route_type")) {
                int v = filter.Get("route_type").As<Napi::Number>().Int32Value();
                if (r.route_type != v) ok = false;
             }
             if (ok) matches.push_back(&r);
        }
    } else {
        for (const auto& [id, r] : data.routes) {
            if (has_filter) {
                if (filter.Has("agency_id")) {
                    std::string v = filter.Get("agency_id").As<Napi::String>().Utf8Value();
                    if (!r.agency_id.has_value() || r.agency_id.value() != v) continue;
                }
                if (filter.Has("route_type")) {
                    int v = filter.Get("route_type").As<Napi::Number>().Int32Value();
                    if (r.route_type != v) continue;
                }
            }
            matches.push_back(&r);
        }
    }

    Napi::Array arr = Napi::Array::New(env, matches.size());
    for (size_t i = 0; i < matches.size(); ++i) {
        const gtfs::Route& r = *matches[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("route_id", r.route_id);
        if (r.agency_id.has_value()) obj.Set("agency_id", r.agency_id.value()); else obj.Set("agency_id", env.Null());
        if (r.route_short_name.has_value()) obj.Set("route_short_name", r.route_short_name.value()); else obj.Set("route_short_name", env.Null());
        if (r.route_long_name.has_value()) obj.Set("route_long_name", r.route_long_name.value()); else obj.Set("route_long_name", env.Null());
        if (r.route_desc.has_value()) obj.Set("route_desc", r.route_desc.value()); else obj.Set("route_desc", env.Null());
        obj.Set("route_type", r.route_type);
        if (r.route_url.has_value()) obj.Set("route_url", r.route_url.value()); else obj.Set("route_url", env.Null());
        if (r.route_color.has_value()) obj.Set("route_color", r.route_color.value()); else obj.Set("route_color", env.Null());
        if (r.route_text_color.has_value()) obj.Set("route_text_color", r.route_text_color.value()); else obj.Set("route_text_color", env.Null());
        if (r.continuous_pickup.has_value()) obj.Set("continuous_pickup", r.continuous_pickup.value()); else obj.Set("continuous_pickup", env.Null());
        if (r.continuous_drop_off.has_value()) obj.Set("continuous_drop_off", r.continuous_drop_off.value()); else obj.Set("continuous_drop_off", env.Null());
        if (r.route_sort_order.has_value()) obj.Set("route_sort_order", r.route_sort_order.value()); else obj.Set("route_sort_order", env.Null());
        if (r.network_id.has_value()) obj.Set("network_id", r.network_id.value()); else obj.Set("network_id", env.Null());
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::UpdateRealtime(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
         Napi::TypeError::New(env, "Expected 3 arguments: alerts, tripUpdates, vehiclePositions").ThrowAsJavaScriptException();
         return env.Null();
    }

    data.realtime_trip_updates.clear();
    data.realtime_vehicle_positions.clear();
    data.realtime_alerts.clear();

    if (info[0].IsBuffer()) {
        Napi::Buffer<unsigned char> buf = info[0].As<Napi::Buffer<unsigned char>>();
        gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 2);
    } else if (info[0].IsArray()) {
        Napi::Array arr = info[0].As<Napi::Array>();
        for(uint32_t i=0; i<arr.Length(); ++i) {
             Napi::Value v = arr[i];
             if(v.IsBuffer()) {
                 Napi::Buffer<unsigned char> buf = v.As<Napi::Buffer<unsigned char>>();
                 gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 2);
             }
        }
    }

    if (info[1].IsBuffer()) {
        Napi::Buffer<unsigned char> buf = info[1].As<Napi::Buffer<unsigned char>>();
        gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 0);
    } else if (info[1].IsArray()) {
        Napi::Array arr = info[1].As<Napi::Array>();
        for(uint32_t i=0; i<arr.Length(); ++i) {
             Napi::Value v = arr[i];
             if(v.IsBuffer()) {
                 Napi::Buffer<unsigned char> buf = v.As<Napi::Buffer<unsigned char>>();
                 gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 0);
             }
        }
    }

    if (info[2].IsBuffer()) {
        Napi::Buffer<unsigned char> buf = info[2].As<Napi::Buffer<unsigned char>>();
        gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 1);
    } else if (info[2].IsArray()) {
        Napi::Array arr = info[2].As<Napi::Array>();
        for(uint32_t i=0; i<arr.Length(); ++i) {
             Napi::Value v = arr[i];
             if(v.IsBuffer()) {
                 Napi::Buffer<unsigned char> buf = v.As<Napi::Buffer<unsigned char>>();
                 gtfs::parse_realtime_feed(data, buf.Data(), buf.Length(), 1);
             }
        }
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

        if (tu.trip.direction_id != -1) trip.Set("direction_id", tu.trip.direction_id);
        else trip.Set("direction_id", env.Null());

        trip.Set("start_time", tu.trip.start_time);
        if (!tu.trip.start_date.empty()) trip.Set("start_date", tu.trip.start_date);
        else trip.Set("start_date", env.Null());

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
            if (stu.stop_sequence != -1) stu_obj.Set("stop_sequence", stu.stop_sequence);
            else stu_obj.Set("stop_sequence", env.Null());

            stu_obj.Set("stop_id", stu.stop_id);
            stu_obj.Set("trip_id", stu.trip_id);
            if (!stu.start_date.empty()) stu_obj.Set("start_date", stu.start_date);
            else stu_obj.Set("start_date", env.Null());
            if (!stu.start_time.empty()) stu_obj.Set("start_time", stu.start_time);
            else stu_obj.Set("start_time", env.Null());

            if (stu.arrival_delay != -2147483648) stu_obj.Set("arrival_delay", stu.arrival_delay);
            else stu_obj.Set("arrival_delay", env.Null());

            if (stu.arrival_time != -1) stu_obj.Set("arrival_time", stu.arrival_time);
            else stu_obj.Set("arrival_time", env.Null());

            if (stu.arrival_uncertainty != -1) stu_obj.Set("arrival_uncertainty", stu.arrival_uncertainty);
            else stu_obj.Set("arrival_uncertainty", env.Null());

            if (stu.departure_delay != -2147483648) stu_obj.Set("departure_delay", stu.departure_delay);
            else stu_obj.Set("departure_delay", env.Null());

            if (stu.departure_time != -1) stu_obj.Set("departure_time", stu.departure_time);
            else stu_obj.Set("departure_time", env.Null());

            if (stu.departure_uncertainty != -1) stu_obj.Set("departure_uncertainty", stu.departure_uncertainty);
            else stu_obj.Set("departure_uncertainty", env.Null());

            stu_obj.Set("schedule_relationship", stu.schedule_relationship);

            stus[j] = stu_obj;
        }
        obj.Set("stop_time_updates", stus);

        if (tu.timestamp != 0) obj.Set("timestamp", (double)tu.timestamp);
        else obj.Set("timestamp", env.Null());

        if (tu.delay != -2147483648) obj.Set("delay", tu.delay);
        else obj.Set("delay", env.Null());

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

        if (vp.trip.direction_id != -1) trip.Set("direction_id", vp.trip.direction_id);
        else trip.Set("direction_id", env.Null());

        trip.Set("start_time", vp.trip.start_time);
        if (!vp.trip.start_date.empty()) trip.Set("start_date", vp.trip.start_date);
        else trip.Set("start_date", env.Null());

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

        if (vp.position.bearing != -1.0f) position.Set("bearing", vp.position.bearing);
        else position.Set("bearing", env.Null());

        if (vp.position.odometer != -1.0) position.Set("odometer", vp.position.odometer);
        else position.Set("odometer", env.Null());

        if (vp.position.speed != -1.0f) position.Set("speed", vp.position.speed);
        else position.Set("speed", env.Null());

        obj.Set("position", position);

        if (vp.current_stop_sequence != -1) obj.Set("current_stop_sequence", vp.current_stop_sequence);
        else obj.Set("current_stop_sequence", env.Null());

        obj.Set("stop_id", vp.stop_id);

        if (vp.current_status != -1) obj.Set("current_status", vp.current_status);
        else obj.Set("current_status", env.Null());

        if (vp.timestamp != 0) obj.Set("timestamp", (double)vp.timestamp);
        else obj.Set("timestamp", env.Null());

        if (vp.congestion_level != -1) obj.Set("congestion_level", vp.congestion_level);
        else obj.Set("congestion_level", env.Null());

        if (vp.occupancy_status != -1) obj.Set("occupancy_status", vp.occupancy_status);
        else obj.Set("occupancy_status", env.Null());

        if (vp.occupancy_percentage != -1) obj.Set("occupancy_percentage", vp.occupancy_percentage);
        else obj.Set("occupancy_percentage", env.Null());

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

        if (a.cause != -1) obj.Set("cause", a.cause);
        else obj.Set("cause", env.Null());

        if (a.effect != -1) obj.Set("effect", a.effect);
        else obj.Set("effect", env.Null());

        obj.Set("url", a.url);
        obj.Set("header_text", a.header_text);
        obj.Set("description_text", a.description_text);

        if (a.severity_level != -1) obj.Set("severity_level", a.severity_level);
        else obj.Set("severity_level", env.Null());

        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetStops(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    std::vector<const gtfs::Stop*> matches;
    matches.reserve(data.stops.size());

    if (has_filter && filter.Has("stop_id")) {
        std::string id = filter.Get("stop_id").As<Napi::String>().Utf8Value();
        if (data.stops.count(id)) {
            const auto& s = data.stops.at(id);
            bool ok = true;
            if (filter.Has("stop_name")) {
                std::string v = filter.Get("stop_name").As<Napi::String>().Utf8Value();
                if (s.stop_name != v) ok = false;
            }
            if (filter.Has("zone_id")) {
                std::string v = filter.Get("zone_id").As<Napi::String>().Utf8Value();
                if (!s.zone_id.has_value() || s.zone_id.value() != v) ok = false;
            }
            if (filter.Has("parent_station")) {
                std::string v = filter.Get("parent_station").As<Napi::String>().Utf8Value();
                if (!s.parent_station.has_value() || s.parent_station.value() != v) ok = false;
            }
            if (ok) matches.push_back(&s);
        }
    } else {
        for (const auto& [id, s] : data.stops) {
            if (has_filter) {
                if (filter.Has("stop_name")) {
                    std::string v = filter.Get("stop_name").As<Napi::String>().Utf8Value();
                    if (s.stop_name != v) continue;
                }
                if (filter.Has("zone_id")) {
                    std::string v = filter.Get("zone_id").As<Napi::String>().Utf8Value();
                    if (!s.zone_id.has_value() || s.zone_id.value() != v) continue;
                }
                if (filter.Has("parent_station")) {
                    std::string v = filter.Get("parent_station").As<Napi::String>().Utf8Value();
                    if (!s.parent_station.has_value() || s.parent_station.value() != v) continue;
                }
            }
            matches.push_back(&s);
        }
    }

    Napi::Array arr = Napi::Array::New(env, matches.size());
    for (size_t i = 0; i < matches.size(); ++i) {
        const gtfs::Stop& s = *matches[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("stop_id", s.stop_id);
        if (s.stop_code.has_value()) obj.Set("stop_code", s.stop_code.value()); else obj.Set("stop_code", env.Null());
        obj.Set("stop_name", s.stop_name);
        if (s.stop_desc.has_value()) obj.Set("stop_desc", s.stop_desc.value()); else obj.Set("stop_desc", env.Null());
        if (s.stop_lat.has_value()) obj.Set("stop_lat", s.stop_lat.value()); else obj.Set("stop_lat", env.Null());
        if (s.stop_lon.has_value()) obj.Set("stop_lon", s.stop_lon.value()); else obj.Set("stop_lon", env.Null());
        if (s.zone_id.has_value()) obj.Set("zone_id", s.zone_id.value()); else obj.Set("zone_id", env.Null());
        if (s.stop_url.has_value()) obj.Set("stop_url", s.stop_url.value()); else obj.Set("stop_url", env.Null());
        if (s.location_type.has_value()) obj.Set("location_type", s.location_type.value()); else obj.Set("location_type", env.Null());
        if (s.parent_station.has_value()) obj.Set("parent_station", s.parent_station.value()); else obj.Set("parent_station", env.Null());
        if (s.stop_timezone.has_value()) obj.Set("stop_timezone", s.stop_timezone.value()); else obj.Set("stop_timezone", env.Null());
        if (s.wheelchair_boarding.has_value()) obj.Set("wheelchair_boarding", s.wheelchair_boarding.value()); else obj.Set("wheelchair_boarding", env.Null());
        if (s.level_id.has_value()) obj.Set("level_id", s.level_id.value()); else obj.Set("level_id", env.Null());
        if (s.platform_code.has_value()) obj.Set("platform_code", s.platform_code.value()); else obj.Set("platform_code", env.Null());
        if (s.tts_stop_name.has_value()) obj.Set("tts_stop_name", s.tts_stop_name.value()); else obj.Set("tts_stop_name", env.Null());
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetStopTimes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Configuration object expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object config = info[0].As<Napi::Object>();
    
    bool has_trip_id = false;
    uint32_t filter_trip_id = 0xFFFFFFFF;
    if (config.Has("trip_id") && config.Get("trip_id").IsString()) {
        std::string s = config.Get("trip_id").As<Napi::String>().Utf8Value();
        filter_trip_id = data.string_pool.get_id(s);
        if (filter_trip_id == 0xFFFFFFFF) return Napi::Array::New(env, 0);
        has_trip_id = true;
    }

    bool has_stop_id = false;
    uint32_t filter_stop_id = 0xFFFFFFFF;
    if (config.Has("stop_id") && config.Get("stop_id").IsString()) {
        std::string s = config.Get("stop_id").As<Napi::String>().Utf8Value();
        filter_stop_id = data.string_pool.get_id(s);
        if (filter_stop_id == 0xFFFFFFFF) return Napi::Array::New(env, 0);
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
            if (has_stop_id && st.stop_id != filter_stop_id) continue;

            if (has_time_window) {
                bool arrival_in = (st.arrival_time.has_value() && st.arrival_time.value() >= filter_start_time && st.arrival_time.value() <= filter_end_time);
                bool departure_in = (st.departure_time.has_value() && st.departure_time.value() >= filter_start_time && st.departure_time.value() <= filter_end_time);
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

    } else if (has_stop_id) {
        if (data.stop_times_by_stop_id.count(filter_stop_id)) {
            const auto& indices = data.stop_times_by_stop_id.at(filter_stop_id);
            for (size_t idx : indices) {
                const gtfs::StopTime& st = data.stop_times[idx];

                if (has_trip_id && st.trip_id != filter_trip_id) continue;

                if (has_time_window) {
                    bool arrival_in = (st.arrival_time.has_value() && st.arrival_time.value() >= filter_start_time && st.arrival_time.value() <= filter_end_time);
                    bool departure_in = (st.departure_time.has_value() && st.departure_time.value() >= filter_start_time && st.departure_time.value() <= filter_end_time);
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
                bool arrival_in = (st.arrival_time.has_value() && st.arrival_time.value() >= filter_start_time && st.arrival_time.value() <= filter_end_time);
                bool departure_in = (st.departure_time.has_value() && st.departure_time.value() >= filter_start_time && st.departure_time.value() <= filter_end_time);
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
        if (st->arrival_time.has_value()) obj.Set("arrival_time", st->arrival_time.value());
        else obj.Set("arrival_time", env.Null());
        if (st->departure_time.has_value()) obj.Set("departure_time", st->departure_time.value());
        else obj.Set("departure_time", env.Null());
        obj.Set("stop_id", data.string_pool.get(st->stop_id));
        obj.Set("stop_sequence", st->stop_sequence);
        if (st->stop_headsign.has_value()) obj.Set("stop_headsign", data.string_pool.get(st->stop_headsign.value()));
        else obj.Set("stop_headsign", env.Null());
        obj.Set("pickup_type", st->pickup_type);
        obj.Set("drop_off_type", st->drop_off_type);
        if (st->shape_dist_traveled.has_value()) obj.Set("shape_dist_traveled", st->shape_dist_traveled.value());
        else obj.Set("shape_dist_traveled", env.Null());
        if (st->timepoint.has_value()) obj.Set("timepoint", st->timepoint.value());
        else obj.Set("timepoint", env.Null());
        if (st->continuous_pickup.has_value()) obj.Set("continuous_pickup", st->continuous_pickup.value());
        else obj.Set("continuous_pickup", env.Null());
        if (st->continuous_drop_off.has_value()) obj.Set("continuous_drop_off", st->continuous_drop_off.value());
        else obj.Set("continuous_drop_off", env.Null());
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
        if (data.feed_info[i].default_lang.has_value()) obj.Set("default_lang", data.feed_info[i].default_lang.value()); else obj.Set("default_lang", env.Null());
        if (data.feed_info[i].feed_start_date.has_value()) obj.Set("feed_start_date", data.feed_info[i].feed_start_date.value()); else obj.Set("feed_start_date", env.Null());
        if (data.feed_info[i].feed_end_date.has_value()) obj.Set("feed_end_date", data.feed_info[i].feed_end_date.value()); else obj.Set("feed_end_date", env.Null());
        if (data.feed_info[i].feed_version.has_value()) obj.Set("feed_version", data.feed_info[i].feed_version.value()); else obj.Set("feed_version", env.Null());
        if (data.feed_info[i].feed_contact_email.has_value()) obj.Set("feed_contact_email", data.feed_info[i].feed_contact_email.value()); else obj.Set("feed_contact_email", env.Null());
        if (data.feed_info[i].feed_contact_url.has_value()) obj.Set("feed_contact_url", data.feed_info[i].feed_contact_url.value()); else obj.Set("feed_contact_url", env.Null());
        arr[i] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetTrips(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    std::vector<const gtfs::Trip*> matches;
    matches.reserve(data.trips.size());

    if (has_filter && filter.Has("trip_id")) {
        std::string id = filter.Get("trip_id").As<Napi::String>().Utf8Value();
        if (data.trips.count(id)) {
            const auto& t = data.trips.at(id);
            bool ok = true;
            if (filter.Has("route_id")) {
                std::string v = filter.Get("route_id").As<Napi::String>().Utf8Value();
                if (t.route_id != v) ok = false;
            }
             if (filter.Has("service_id")) {
                std::string v = filter.Get("service_id").As<Napi::String>().Utf8Value();
                if (t.service_id != v) ok = false;
            }
            if (ok) matches.push_back(&t);
        }
    } else {
        for (const auto& [id, t] : data.trips) {
            if (has_filter) {
                if (filter.Has("route_id")) {
                    std::string v = filter.Get("route_id").As<Napi::String>().Utf8Value();
                    if (t.route_id != v) continue;
                }
                 if (filter.Has("service_id")) {
                    std::string v = filter.Get("service_id").As<Napi::String>().Utf8Value();
                    if (t.service_id != v) continue;
                }
            }
            matches.push_back(&t);
        }
    }

    Napi::Array arr = Napi::Array::New(env, matches.size());
    int i = 0;
    for (const auto* t_ptr : matches) {
        const auto& t = *t_ptr;
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("trip_id", t.trip_id);
        obj.Set("route_id", t.route_id);
        obj.Set("service_id", t.service_id);
        if (t.trip_headsign.has_value()) obj.Set("trip_headsign", t.trip_headsign.value()); else obj.Set("trip_headsign", env.Null());
        if (t.trip_short_name.has_value()) obj.Set("trip_short_name", t.trip_short_name.value()); else obj.Set("trip_short_name", env.Null());
        if (t.direction_id.has_value()) obj.Set("direction_id", t.direction_id.value()); else obj.Set("direction_id", env.Null());
        if (t.block_id.has_value()) obj.Set("block_id", t.block_id.value()); else obj.Set("block_id", env.Null());
        if (t.shape_id.has_value()) obj.Set("shape_id", t.shape_id.value()); else obj.Set("shape_id", env.Null());
        if (t.wheelchair_accessible.has_value()) obj.Set("wheelchair_accessible", t.wheelchair_accessible.value()); else obj.Set("wheelchair_accessible", env.Null());
        if (t.bikes_allowed.has_value()) obj.Set("bikes_allowed", t.bikes_allowed.value()); else obj.Set("bikes_allowed", env.Null());
        arr[i++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetShapes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    Napi::Array arr = Napi::Array::New(env);

    size_t count = 0;
    for (size_t i = 0; i < data.shapes.size(); ++i) {
        if (has_filter) {
             if (filter.Has("shape_id")) {
                  std::string v = filter.Get("shape_id").As<Napi::String>().Utf8Value();
                  if (data.shapes[i].shape_id != v) continue;
             }
        }

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("shape_id", data.shapes[i].shape_id);
        obj.Set("shape_pt_lat", data.shapes[i].shape_pt_lat);
        obj.Set("shape_pt_lon", data.shapes[i].shape_pt_lon);
        obj.Set("shape_pt_sequence", data.shapes[i].shape_pt_sequence);
        if (data.shapes[i].shape_dist_traveled.has_value()) obj.Set("shape_dist_traveled", data.shapes[i].shape_dist_traveled.value()); else obj.Set("shape_dist_traveled", env.Null());
        arr[count++] = obj;
    }
    return arr;
}

Napi::Value GTFSAddon::GetCalendars(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    std::vector<const gtfs::Calendar*> matches;
    matches.reserve(data.calendars.size());

    if (has_filter && filter.Has("service_id")) {
        std::string id = filter.Get("service_id").As<Napi::String>().Utf8Value();
        if (data.calendars.count(id)) {
             matches.push_back(&data.calendars.at(id));
        }
    } else {
        for (const auto& [id, c] : data.calendars) {
             matches.push_back(&c);
        }
    }

    Napi::Array arr = Napi::Array::New(env, matches.size());
    int i = 0;
    for (const auto* c_ptr : matches) {
        const auto& c = *c_ptr;
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
    std::vector<gtfs::CalendarDate> flat_list;

    // Support filtering?
    Napi::Object filter;
    bool has_filter = false;
    if (info.Length() > 0 && info[0].IsObject()) {
        filter = info[0].As<Napi::Object>();
        has_filter = true;
    }

    if (has_filter && filter.Has("service_id")) {
        std::string id = filter.Get("service_id").As<Napi::String>().Utf8Value();
        if (data.calendar_dates.count(id)) {
            const auto& dates = data.calendar_dates.at(id);
            for (const auto& [date, exc] : dates) {
                gtfs::CalendarDate cd;
                cd.service_id = id;
                cd.date = date;
                cd.exception_type = exc;
                flat_list.push_back(cd);
            }
        }
    } else {
        for (const auto& [service_id, dates] : data.calendar_dates) {
            for (const auto& [date, exc] : dates) {
                gtfs::CalendarDate cd;
                cd.service_id = service_id;
                cd.date = date;
                cd.exception_type = exc;
                flat_list.push_back(cd);
            }
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
